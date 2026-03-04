/**
 * Shared utilities for Google Generative AI and Google Cloud Code Assist providers.
 */

import {
	type Content,
	FinishReason,
	FunctionCallingConfigMode,
	type Tool as GoogleTool,
	type Part,
} from "@google/genai";
import type { Context, ImageContent, Model, Tool as PiTool, StopReason, TextContent } from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

type GoogleApiType = "google-generative-ai" | "google-gemini-cli" | "google-vertex";

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.map((item) => asString(item)).filter((item): item is string => item !== undefined);
	return values.length > 0 ? values : undefined;
}

function summarizeSources(chunks: unknown): string | undefined {
	if (!Array.isArray(chunks)) return undefined;
	const sources: string[] = [];
	for (const chunk of chunks) {
		if (!isRecord(chunk)) continue;
		const web = isRecord(chunk.web) ? chunk.web : undefined;
		const retrievedContext = isRecord(chunk.retrievedContext) ? chunk.retrievedContext : undefined;
		const title = asString(web?.title) ?? asString(retrievedContext?.title);
		const uri = asString(web?.uri) ?? asString(retrievedContext?.uri);
		if (!title && !uri) continue;
		sources.push(title && uri ? `${title} (${uri})` : (title ?? uri)!);
		if (sources.length >= 3) break;
	}
	return sources.length > 0 ? sources.join(" | ") : undefined;
}

function summarizeSearchResults(results: unknown): string | undefined {
	if (!Array.isArray(results)) return undefined;
	const summarized: string[] = [];
	for (const result of results) {
		if (!isRecord(result)) continue;
		const title = asString(result.title);
		const uri = asString(result.uri) ?? asString(result.url) ?? asString(result.link);
		if (!title && !uri) continue;
		summarized.push(title && uri ? `${title} (${uri})` : (title ?? uri)!);
		if (summarized.length >= 3) break;
	}
	return summarized.length > 0 ? summarized.join(" | ") : undefined;
}

function stringifyStable(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export interface NativeWebSearchSignal {
	signature: string;
	message: string;
	webSearchCallsIncrement: number;
}

export function extractNativeWebSearchSignalsFromPart(part: Part): NativeWebSearchSignal[] {
	const record = part as Part & {
		googleSearchCall?: unknown;
		googleSearchResult?: unknown;
		google_search_call?: unknown;
		google_search_result?: unknown;
	};
	const signals: NativeWebSearchSignal[] = [];

	const searchCall = record.googleSearchCall ?? record.google_search_call;
	if (searchCall !== undefined) {
		const query =
			isRecord(searchCall) && asString(searchCall.query ?? searchCall.searchQuery ?? searchCall.search_query);
		const summary = query ? `query: ${query}` : "query sent";
		signals.push({
			signature: `part-call:${query ?? stringifyStable(searchCall)}`,
			message: `[Native web search] ${summary}.`,
			webSearchCallsIncrement: 1,
		});
	}

	const searchResult = record.googleSearchResult ?? record.google_search_result;
	if (searchResult !== undefined) {
		const resultSummary = isRecord(searchResult)
			? (summarizeSearchResults(searchResult.result ?? searchResult.results ?? searchResult.items ?? []) ??
				summarizeSources(searchResult.result ?? searchResult.results ?? searchResult.items ?? []))
			: undefined;
		signals.push({
			signature: `part-result:${resultSummary ?? stringifyStable(searchResult)}`,
			message: resultSummary
				? `[Native web search] results: ${resultSummary}`
				: "[Native web search] result received.",
			webSearchCallsIncrement: 0,
		});
	}

	return signals;
}

export function extractNativeWebSearchSignalsFromGroundingMetadata(
	groundingMetadata: unknown,
): NativeWebSearchSignal[] {
	if (!isRecord(groundingMetadata)) return [];
	const signals: NativeWebSearchSignal[] = [];

	const queries = asStringArray(groundingMetadata.webSearchQueries ?? groundingMetadata.web_search_queries);
	if (queries) {
		signals.push({
			signature: `grounding-queries:${queries.join("|")}`,
			message: `[Native web search] grounding queries: ${queries.join(" | ")}`,
			webSearchCallsIncrement: 1,
		});
	}

	const sourceSummary = summarizeSources(groundingMetadata.groundingChunks ?? groundingMetadata.grounding_chunks);
	if (sourceSummary) {
		signals.push({
			signature: `grounding-sources:${sourceSummary}`,
			message: `[Native web search] sources: ${sourceSummary}`,
			webSearchCallsIncrement: 0,
		});
	}

	if (signals.length === 0) {
		signals.push({
			signature: `grounding-present:${stringifyStable(groundingMetadata)}`,
			message: "[Native web search] grounding metadata received.",
			webSearchCallsIncrement: 1,
		});
	}

	return signals;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
export function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				const filteredParts = !model.input.includes("image") ? parts.filter((p) => p.text !== undefined) : parts;
				if (filteredParts.length === 0) continue;
				contents.push({
					role: "user",
					parts: filteredParts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// Check if message is from same provider and model - only then keep thinking blocks
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					// Skip empty text blocks - they can cause issues with some models (e.g. Claude via Antigravity)
					if (!block.text || block.text.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// Skip empty thinking blocks
					if (!block.thinking || block.thinking.trim() === "") continue;
					// Only keep as thinking block if same provider AND same model
					// Otherwise convert to plain text (no tags to avoid model mimicking them)
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					// Gemini 3 requires thoughtSignature on all function calls when thinking mode is enabled.
					// When replaying history from providers without thought signatures (e.g. Claude via Antigravity),
					// convert unsigned function calls to text to avoid API validation errors.
					// We include a note telling the model this is historical context to prevent mimicry.
					const isGemini3 = model.id.toLowerCase().includes("gemini-3");
					if (isGemini3 && !thoughtSignature) {
						const argsStr = JSON.stringify(block.arguments ?? {}, null, 2);
						parts.push({
							text: `[Historical context: a different model called tool "${block.name}" with arguments: ${argsStr}. Do not mimic this format - use proper function calling.]`,
						});
					} else {
						const part: Part = {
							functionCall: {
								name: block.name,
								args: block.arguments ?? {},
								...(requiresToolCallId(model.id) ? { id: block.id } : {}),
							},
						};
						if (thoughtSignature) {
							part.thoughtSignature = thoughtSignature;
						}
						parts.push(part);
					}
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3 supports multimodal function responses with images nested inside functionResponse.parts
			// See: https://ai.google.dev/gemini-api/docs/function-calling#multimodal
			// Older models don't support this, so we put images in a separate user message.
			const supportsMultimodalFunctionResponse = model.id.includes("gemini-3");

			// Use "output" key for success, "error" key for errors as per SDK documentation
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					// Nest images inside functionResponse.parts for Gemini 3
					...(hasImages && supportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// For older models, add images in a separate user message
			if (hasImages && !supportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, const, etc.). Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
export interface ConvertGoogleToolsOptions {
	useParameters?: boolean;
	enableNativeWebSearch?: boolean;
}

function resolveConvertGoogleToolsOptions(
	optionsOrUseParameters: boolean | ConvertGoogleToolsOptions,
): ConvertGoogleToolsOptions {
	if (typeof optionsOrUseParameters === "boolean") {
		return { useParameters: optionsOrUseParameters };
	}
	return optionsOrUseParameters;
}

export function convertTools(
	tools: PiTool[],
	optionsOrUseParameters: boolean | ConvertGoogleToolsOptions = false,
): GoogleTool[] | undefined {
	const options = resolveConvertGoogleToolsOptions(optionsOrUseParameters);
	const useParameters = options.useParameters ?? false;
	const enableNativeWebSearch = options.enableNativeWebSearch === true;

	const convertedTools: GoogleTool[] = [];

	if (tools.length > 0) {
		convertedTools.push({
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				...(useParameters ? { parameters: tool.parameters } : { parametersJsonSchema: tool.parameters }),
			})) as NonNullable<GoogleTool["functionDeclarations"]>,
		});
	}

	if (enableNativeWebSearch) {
		convertedTools.push({ googleSearch: {} });
	}

	if (convertedTools.length === 0) {
		return undefined;
	}

	return convertedTools;
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}
