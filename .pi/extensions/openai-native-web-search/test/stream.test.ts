import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import type { AssistantMessageEventStream } from "../../../../packages/ai/src/utils/event-stream.js";
import type { AssistantMessageWithWebSearch, ModelWithWebSearchCost } from "../types.js";
import { processResponsesStreamWithNativeWebSearch } from "../openai-stream.js";

function createModel(): ModelWithWebSearchCost<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32000,
	};
}

function createOutput(model: ModelWithWebSearchCost<"openai-responses">): AssistantMessageWithWebSearch {
	return {
		role: "assistant",
		content: [],
		api: model.api,
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
}

async function* toAsyncIterable(events: ResponseStreamEvent[]): AsyncGenerator<ResponseStreamEvent> {
	for (const event of events) {
		yield event;
	}
}

describe("web search stream parsing", () => {
	it("keeps stable content indices during interleaved reasoning and web search events", async () => {
		const model = createModel();
		const output = createOutput(model);
		const emitted: unknown[] = [];
		const sink = {
			push(event: unknown) {
				emitted.push(event);
			},
		} as AssistantMessageEventStream;

		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				item: { type: "reasoning", id: "rs_1", summary: [] },
				output_index: 0,
				sequence_number: 1,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.reasoning_summary_part.added",
				part: { type: "summary_text", text: "" },
				item_id: "rs_1",
				output_index: 0,
				summary_index: 0,
				sequence_number: 2,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.reasoning_summary_text.delta",
				delta: "alpha",
				item_id: "rs_1",
				output_index: 0,
				summary_index: 0,
				sequence_number: 3,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.web_search_call.in_progress",
				item_id: "ws_1",
				output_index: 1,
				sequence_number: 4,
			} as ResponseStreamEvent,
			{
				type: "response.reasoning_summary_text.delta",
				delta: "beta",
				item_id: "rs_1",
				output_index: 0,
				summary_index: 0,
				sequence_number: 5,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.web_search_call.completed",
				item_id: "ws_1",
				output_index: 1,
				sequence_number: 4,
			} as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "alphabeta" }] },
				output_index: 0,
				sequence_number: 6,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				item: {
					type: "web_search_call",
					id: "ws_1",
					status: "completed",
					action: {
						type: "search",
						query: "latest headline",
						sources: [{ type: "url", url: "https://example.com" }],
					},
					results: [{ url: "https://example.com/article" }],
				},
				output_index: 1,
				sequence_number: 7,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						total_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 0 },
					},
				},
				sequence_number: 8,
			} as unknown as ResponseStreamEvent,
		];

		await processResponsesStreamWithNativeWebSearch(toAsyncIterable(events), output, sink, model);

		const reasoningDeltas = emitted.filter(
			(event): event is { type: "thinking_delta"; contentIndex: number; delta: string } =>
				typeof event === "object" &&
				event !== null &&
				"type" in event &&
				(event as { type?: unknown }).type === "thinking_delta" &&
				((event as { delta?: string }).delta === "alpha" || (event as { delta?: string }).delta === "beta"),
		);
		expect(reasoningDeltas).toHaveLength(2);
		expect(reasoningDeltas[0].contentIndex).toBe(0);
		expect(reasoningDeltas[1].contentIndex).toBe(0);

		const webSearchDeltas = emitted.filter(
			(event): event is { type: "thinking_delta"; contentIndex: number; delta: string } =>
				typeof event === "object" &&
				event !== null &&
				"type" in event &&
				(event as { type?: unknown }).type === "thinking_delta" &&
				typeof (event as { delta?: unknown }).delta === "string" &&
				(event as { delta: string }).delta.includes("Web search"),
		);
		expect(webSearchDeltas.length).toBeGreaterThan(0);
		for (const event of webSearchDeltas) {
			expect(event.contentIndex).toBe(1);
		}

		const thinkingBlocks = output.content.filter((block) => block.type === "thinking");
		expect(thinkingBlocks).toHaveLength(2);
		expect(thinkingBlocks[1]?.thinking).toContain("Query: latest headline");
		expect(thinkingBlocks[1]?.thinking).toContain("Sources: https://example.com");
		expect(thinkingBlocks[1]?.thinking).toContain("Result URLs: https://example.com/article");
		expect(output.usage.webSearchCalls).toBe(1);
		expect(output.usage.cost.webSearch).toBe(0.01);
		expect(output.usage.cost.total).toBe(0.01);
	});
});
