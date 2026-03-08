import type * as NodeOs from "node:os";
import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
	Tool as OpenAITool,
} from "openai/resources/responses/responses.js";

let osModule: typeof NodeOs | null = null;
const dynamicImport = (specifier: string) => import(specifier);
const NODE_OS_SPECIFIER = "node:" + "os";

if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	dynamicImport(NODE_OS_SPECIFIER).then((module) => {
		osModule = module as typeof NodeOs;
	});
}

import { getEnvApiKey } from "../../../packages/ai/src/env-api-keys.js";
import { supportsXhigh } from "../../../packages/ai/src/models.js";
import { streamSimpleOpenAICodexResponses } from "../../../packages/ai/src/providers/openai-codex-responses.js";
import { convertResponsesMessages, convertResponsesTools } from "../../../packages/ai/src/providers/openai-responses-shared.js";
import { buildBaseOptions, clampReasoning } from "../../../packages/ai/src/providers/simple-options.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../../../packages/ai/src/types.js";
import { AssistantMessageEventStream } from "../../../packages/ai/src/utils/event-stream.js";
import { processResponsesStreamWithNativeWebSearch } from "./openai-stream.js";
import { evaluateNativeWebSearchPolicy } from "./policy.js";
import { extractDirectiveContext } from "./state.js";
import type { AssistantMessageWithWebSearch, ModelWithWebSearchCost } from "./types.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	textVerbosity?: "low" | "medium" | "high";
}

interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: "auto";
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

export interface BuildCodexRequestBodyResult {
	body: RequestBody;
	context: Context;
	decision: ReturnType<typeof evaluateNativeWebSearchPolicy>;
}

function includeValues(body: RequestBody, values: string[]): void {
	const includeSet = new Set(body.include ?? []);
	for (const value of values) {
		includeSet.add(value);
	}
	body.include = Array.from(includeSet);
}

function convertResponsesToolsWithNativeWebSearch(
	tools: Context["tools"],
	includeNativeWebSearch: boolean,
): OpenAITool[] | undefined {
	const mappedTools = tools ? convertResponsesTools(tools, { strict: null }) : [];
	if (includeNativeWebSearch) {
		mappedTools.push({ type: "web_search" });
	}
	return mappedTools.length > 0 ? mappedTools : undefined;
}

function clampReasoningEffort(modelId: string, effort: string): string {
	const id = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
	if ((id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4")) && effort === "minimal") {
		return "low";
	}
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
	return effort;
}

export function buildCodexRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): BuildCodexRequestBodyResult {
	const { context: cleanContext, optedIn } = extractDirectiveContext(context);
	const decision = evaluateNativeWebSearchPolicy(model, options?.reasoningEffort, optedIn);
	const messages = convertResponsesMessages(model, cleanContext, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
	});

	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: cleanContext.systemPrompt,
		input: messages,
		text: { verbosity: options?.textVerbosity || "medium" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	const mappedTools = convertResponsesToolsWithNativeWebSearch(cleanContext.tools, decision.enabled);
	if (mappedTools) {
		body.tools = mappedTools;
	}
	if (decision.enabled) {
		includeValues(body, ["web_search_call.results", "web_search_call.action.sources"]);
	}

	if (options?.reasoningEffort !== undefined) {
		body.reasoning = {
			effort: clampReasoningEffort(model.id, options.reasoningEffort),
			summary: options.reasoningSummary ?? "auto",
		};
	}

	return {
		body,
		context: cleanContext,
		decision,
	};
}

function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Request was aborted"));
			},
			{ once: true },
		);
	});
}

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(atob(parts[1])) as Record<string, unknown>;
		const authPayload = payload[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
		const accountId = authPayload?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function buildHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = new Headers(initHeaders);
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("originator", "pi");
	const userAgent = osModule ? `pi (${osModule.platform()} ${osModule.release()}; ${osModule.arch()})` : "pi (browser)";
	headers.set("User-Agent", userAgent);
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		headers.set(key, value);
	}
	if (sessionId) {
		headers.set("session_id", sessionId);
	}
	return headers;
}

async function parseErrorResponse(response: Response): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;

	try {
		const parsed = JSON.parse(raw) as {
			error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number };
		};
		const error = parsed.error;
		if (error) {
			const code = error.code || error.type || "";
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				const plan = error.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
				const minutes = error.resets_at
					? Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60000))
					: undefined;
				const when = minutes !== undefined ? ` Try again in ~${minutes} min.` : "";
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			message = error.message || friendlyMessage || message;
		}
	} catch {
		// Ignore malformed error payloads.
	}

	return { message, friendlyMessage };
}

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let index = buffer.indexOf("\n\n");
		while (index !== -1) {
			const chunk = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);

			const dataLines = chunk
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim());
			if (dataLines.length > 0) {
				const data = dataLines.join("\n").trim();
				if (data && data !== "[DONE]") {
					try {
						yield JSON.parse(data) as Record<string, unknown>;
					} catch {
						// Ignore malformed chunks.
					}
				}
			}
			index = buffer.indexOf("\n\n");
		}
	}
}

async function* mapCodexEvents(events: AsyncIterable<Record<string, unknown>>): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const code = (event as { code?: string }).code || "";
			const message = (event as { message?: string }).message || "";
			throw new Error(`Codex error: ${message || code || JSON.stringify(event)}`);
		}

		if (type === "response.failed") {
			const message = (event as { response?: { error?: { message?: string } } }).response?.error?.message;
			throw new Error(message || "Codex response failed");
		}

		if (type === "response.done" || type === "response.completed") {
			const response = (event as { response?: { status?: unknown } }).response;
			yield { ...event, type: "response.completed", response } as ResponseStreamEvent;
			continue;
		}

		yield event as ResponseStreamEvent;
	}
}

const streamOpenAICodexResponsesWithNativeWebSearch: StreamFunction<
	"openai-codex-responses",
	OpenAICodexResponsesOptions
> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessageWithWebSearch = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const accountId = extractAccountId(apiKey);
			const { body } = buildCodexRequestBody(model, context, options);
			options?.onPayload?.(body);
			const headers = buildHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId);
			const bodyJson = JSON.stringify(body);
			let response: Response | undefined;
			let lastError: Error | undefined;

			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					response = await fetch(resolveCodexUrl(model.baseUrl), {
						method: "POST",
						headers,
						body: bodyJson,
						signal: options?.signal,
					});

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
						await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
						continue;
					}

					const info = await parseErrorResponse(
						new Response(errorText, { status: response.status, statusText: response.statusText }),
					);
					throw new Error(info.friendlyMessage || info.message);
				} catch (error) {
					if (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted")) {
						throw new Error("Request was aborted");
					}
					lastError = error instanceof Error ? error : new Error(String(error));
					if (attempt < MAX_RETRIES && !lastError.message.includes("usage limit")) {
						await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}
			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output as AssistantMessage });
			await processResponsesStreamWithNativeWebSearch(
				mapCodexEvents(parseSSE(response)),
				output,
				stream,
				model as ModelWithWebSearchCost<"openai-codex-responses">,
			);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output as AssistantMessage });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output as AssistantMessage });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleOpenAICodexResponsesWithNativeWebSearch: StreamFunction<
	"openai-codex-responses",
	SimpleStreamOptions
> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const reasoningEffort = supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning);
	const codexOptions: OpenAICodexResponsesOptions = {
		...base,
		reasoningEffort,
	};
	const { context: cleanContext, decision } = buildCodexRequestBody(model, context, codexOptions);
	if (!decision.enabled) {
		return streamSimpleOpenAICodexResponses(model, cleanContext, options);
	}
	return streamOpenAICodexResponsesWithNativeWebSearch(model, context, codexOptions);
};
