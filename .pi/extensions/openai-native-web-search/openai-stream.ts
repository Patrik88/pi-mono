import type OpenAI from "openai";
import type {
	ResponseCreateParamsStreaming,
	ResponseFunctionToolCall,
	ResponseFunctionWebSearch,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../../../packages/ai/src/models.js";
import type {
	Api,
	AssistantMessageEvent,
	Model,
	StopReason,
	TextSignatureV1,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "../../../packages/ai/src/types.js";
import type { AssistantMessageEventStream } from "../../../packages/ai/src/utils/event-stream.js";
import { parseStreamingJson } from "../../../packages/ai/src/utils/json-parse.js";
import { applyWebSearchPricing } from "./pricing.js";
import type { AssistantMessageWithWebSearch, ModelWithWebSearchCost, UsageWithWebSearch } from "./types.js";

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function getServiceTierCostMultiplier(serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(usage: Usage, serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined) {
	const multiplier = getServiceTierCostMultiplier(serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

interface WebSearchCallActionSource {
	type?: string;
	url?: string;
}

interface WebSearchCallAction {
	type?: string;
	query?: string;
	queries?: string[];
	url?: string;
	pattern?: string;
	sources?: WebSearchCallActionSource[];
}

interface WebSearchCallResult {
	title?: string;
	url?: string;
	snippet?: string;
}

interface WebSearchCallWithExtras extends ResponseFunctionWebSearch {
	action?: WebSearchCallAction;
	results?: WebSearchCallResult[];
}

export interface NativeResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

export async function processResponsesStreamWithNativeWebSearch<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessageWithWebSearch,
	stream: AssistantMessageEventStream,
	model: ModelWithWebSearchCost<TApi>,
	options?: NativeResponsesStreamOptions,
): Promise<void> {
	const blocks = output.content;
	let currentItem: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | null = null;
	let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null = null;
	let currentContentIndex: number | null = null;
	let webSearchCalls = 0;
	const webSearchContentIndexBySequence = new Map<number, number>();
	const webSearchSequenceByItemId = new Map<string, number>();
	const lastWebSearchStatusBySequence = new Map<number, string>();
	const closedWebSearchSequences = new Set<number>();

	const appendEvent = (event: AssistantMessageEvent): void => {
		stream.push(event);
	};

	const appendThinkingDelta = (contentIndex: number, delta: string): void => {
		const block = blocks[contentIndex];
		if (!block || block.type !== "thinking") return;
		const prefix = block.thinking.length > 0 ? "\n" : "";
		block.thinking += `${prefix}${delta}`;
		appendEvent({
			type: "thinking_delta",
			contentIndex,
			delta: `${prefix}${delta}`,
			partial: output,
		});
	};

	const ensureWebSearchThinkingBlock = (sequenceNumber: number): number => {
		const existingIndex = webSearchContentIndexBySequence.get(sequenceNumber);
		if (existingIndex !== undefined) {
			return existingIndex;
		}

		const thinkingBlock: ThinkingContent = { type: "thinking", thinking: "" };
		blocks.push(thinkingBlock);
		const contentIndex = blocks.length - 1;
		appendEvent({ type: "thinking_start", contentIndex, partial: output });
		webSearchContentIndexBySequence.set(sequenceNumber, contentIndex);
		return contentIndex;
	};

	const finishWebSearchThinkingBlock = (sequenceNumber: number): void => {
		const contentIndex = webSearchContentIndexBySequence.get(sequenceNumber);
		if (contentIndex === undefined || closedWebSearchSequences.has(sequenceNumber)) {
			return;
		}

		const block = blocks[contentIndex];
		if (block?.type === "thinking") {
			appendEvent({
				type: "thinking_end",
				contentIndex,
				content: block.thinking,
				partial: output,
			});
			closedWebSearchSequences.add(sequenceNumber);
		}
	};

	const sequenceFromItemId = (itemId: string): number | undefined => webSearchSequenceByItemId.get(itemId);

	const getWebSearchStatusLabel = (
		type:
			| "response.web_search_call.in_progress"
			| "response.web_search_call.searching"
			| "response.web_search_call.completed",
	): string => {
		switch (type) {
			case "response.web_search_call.in_progress":
				return "Web search started";
			case "response.web_search_call.searching":
				return "Web search in progress";
			case "response.web_search_call.completed":
				return "Web search finished";
		}
	};

	const getWebSearchSummaryLines = (item: ResponseFunctionWebSearch): string[] => {
		const lines: string[] = [];
		const enriched = item as WebSearchCallWithExtras;
		const action = enriched.action;
		if (!action) {
			return lines;
		}

		if (action.type === "search") {
			const queries = action.queries?.filter((query) => query.length > 0) ?? [];
			if (queries.length > 0) {
				lines.push(`Queries: ${queries.join(", ")}`);
			} else if (action.query) {
				lines.push(`Query: ${action.query}`);
			}
		} else if (action.type === "open_page" && action.url) {
			lines.push(`Opened page: ${action.url}`);
		} else if (action.type === "find") {
			if (action.pattern) {
				lines.push(`Find pattern: ${action.pattern}`);
			}
			if (action.url) {
				lines.push(`Find URL: ${action.url}`);
			}
		}

		const sourceUrls = (action.sources ?? [])
			.map((source) => source.url)
			.filter((url): url is string => typeof url === "string" && url.length > 0);
		if (sourceUrls.length > 0) {
			const displayed = sourceUrls.slice(0, 5);
			lines.push(`Sources: ${displayed.join(", ")}${sourceUrls.length > 5 ? ", ..." : ""}`);
		}

		const resultUrls = (enriched.results ?? [])
			.map((result) => result.url)
			.filter((url): url is string => typeof url === "string" && url.length > 0);
		if (resultUrls.length > 0) {
			lines.push(`Result URLs: ${resultUrls.slice(0, 3).join(", ")}${resultUrls.length > 3 ? ", ..." : ""}`);
		}

		return lines;
	};

	for await (const event of openaiStream) {
		if (event.type === "response.output_item.added") {
			const item = event.item;
			if (item.type === "reasoning") {
				currentItem = item;
				currentBlock = { type: "thinking", thinking: "" };
				blocks.push(currentBlock);
				currentContentIndex = blocks.length - 1;
				appendEvent({ type: "thinking_start", contentIndex: currentContentIndex, partial: output });
			} else if (item.type === "message") {
				currentItem = item;
				currentBlock = { type: "text", text: "" };
				blocks.push(currentBlock);
				currentContentIndex = blocks.length - 1;
				appendEvent({ type: "text_start", contentIndex: currentContentIndex, partial: output });
			} else if (item.type === "function_call") {
				currentItem = item;
				currentBlock = {
					type: "toolCall",
					id: `${item.call_id}|${item.id}`,
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				};
				blocks.push(currentBlock);
				currentContentIndex = blocks.length - 1;
				appendEvent({ type: "toolcall_start", contentIndex: currentContentIndex, partial: output });
			}
		} else if (
			event.type === "response.web_search_call.in_progress" ||
			event.type === "response.web_search_call.searching" ||
			event.type === "response.web_search_call.completed"
		) {
			webSearchSequenceByItemId.set(event.item_id, event.sequence_number);
			const contentIndex = ensureWebSearchThinkingBlock(event.sequence_number);
			const statusLabel = getWebSearchStatusLabel(event.type);
			if (lastWebSearchStatusBySequence.get(event.sequence_number) !== statusLabel) {
				appendThinkingDelta(contentIndex, statusLabel);
				lastWebSearchStatusBySequence.set(event.sequence_number, statusLabel);
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			if (currentItem && currentItem.type === "reasoning") {
				currentItem.summary = currentItem.summary || [];
				currentItem.summary.push(event.part);
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking" && currentContentIndex !== null) {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					currentBlock.thinking += event.delta;
					lastPart.text += event.delta;
					appendEvent({
						type: "thinking_delta",
						contentIndex: currentContentIndex,
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking" && currentContentIndex !== null) {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					currentBlock.thinking += "\n\n";
					lastPart.text += "\n\n";
					appendEvent({
						type: "thinking_delta",
						contentIndex: currentContentIndex,
						delta: "\n\n",
						partial: output,
					});
				}
			}
		} else if (event.type === "response.content_part.added") {
			if (currentItem?.type === "message") {
				currentItem.content = currentItem.content || [];
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					currentItem.content.push(event.part);
				}
			}
		} else if (event.type === "response.output_text.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text" && currentContentIndex !== null) {
				if (!currentItem.content || currentItem.content.length === 0) {
					continue;
				}
				const lastPart = currentItem.content[currentItem.content.length - 1];
				if (lastPart?.type === "output_text") {
					currentBlock.text += event.delta;
					lastPart.text += event.delta;
					appendEvent({
						type: "text_delta",
						contentIndex: currentContentIndex,
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.refusal.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text" && currentContentIndex !== null) {
				if (!currentItem.content || currentItem.content.length === 0) {
					continue;
				}
				const lastPart = currentItem.content[currentItem.content.length - 1];
				if (lastPart?.type === "refusal") {
					currentBlock.text += event.delta;
					lastPart.refusal += event.delta;
					appendEvent({
						type: "text_delta",
						contentIndex: currentContentIndex,
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			if (
				currentItem?.type === "function_call" &&
				currentBlock?.type === "toolCall" &&
				currentContentIndex !== null
			) {
				currentBlock.partialJson += event.delta;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
				appendEvent({
					type: "toolcall_delta",
					contentIndex: currentContentIndex,
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.function_call_arguments.done") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson = event.arguments;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;

			if (item.type === "reasoning" && currentBlock?.type === "thinking" && currentContentIndex !== null) {
				currentBlock.thinking = item.summary?.map((summary) => summary.text).join("\n\n") || "";
				currentBlock.thinkingSignature = JSON.stringify(item);
				appendEvent({
					type: "thinking_end",
					contentIndex: currentContentIndex,
					content: currentBlock.thinking,
					partial: output,
				});
				currentBlock = null;
				currentItem = null;
				currentContentIndex = null;
			} else if (item.type === "message" && currentBlock?.type === "text" && currentContentIndex !== null) {
				currentBlock.text = item.content.map((content) => (content.type === "output_text" ? content.text : content.refusal)).join("");
				currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				appendEvent({
					type: "text_end",
					contentIndex: currentContentIndex,
					content: currentBlock.text,
					partial: output,
				});
				currentBlock = null;
				currentItem = null;
				currentContentIndex = null;
			} else if (item.type === "function_call" && currentContentIndex !== null) {
				const args =
					currentBlock?.type === "toolCall" && currentBlock.partialJson
						? parseStreamingJson(currentBlock.partialJson)
						: parseStreamingJson(item.arguments || "{}");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: `${item.call_id}|${item.id}`,
					name: item.name,
					arguments: args,
				};

				currentBlock = null;
				currentItem = null;
				appendEvent({ type: "toolcall_end", contentIndex: currentContentIndex, toolCall, partial: output });
				currentContentIndex = null;
			} else if (item.type === "web_search_call") {
				webSearchCalls++;
				const mappedSequenceNumber = sequenceFromItemId(item.id);
				const sequenceNumber = mappedSequenceNumber ?? webSearchCalls;
				const contentIndex = ensureWebSearchThinkingBlock(sequenceNumber);
				const summaryLines = getWebSearchSummaryLines(item);
				for (const line of summaryLines) {
					appendThinkingDelta(contentIndex, line);
				}
				finishWebSearchThinkingBlock(sequenceNumber);
			}
		} else if (event.type === "response.completed") {
			for (const sequenceNumber of webSearchContentIndexBySequence.keys()) {
				finishWebSearchThinkingBlock(sequenceNumber);
			}
			const response = event.response;
			if (response?.usage) {
				const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
				output.usage = {
					input: (response.usage.input_tokens || 0) - cachedTokens,
					output: response.usage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					totalTokens: response.usage.total_tokens || 0,
					webSearchCalls,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0, total: 0 },
				} satisfies UsageWithWebSearch;
			}
			calculateCost(model, output.usage);
			applyServiceTierPricing(output.usage, response?.service_tier ?? options?.serviceTier);
			applyWebSearchPricing(model, output.usage);
			output.stopReason = mapStopReason(response?.status);
			if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			throw new Error("Unknown error");
		}
	}
}

export function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${exhaustive}`);
		}
	}
}
