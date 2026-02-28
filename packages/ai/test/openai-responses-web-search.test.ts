import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { buildParams } from "../src/providers/openai-responses.js";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
} from "../src/types.js";

function createModel(webSearchPerCall?: number): Model<"openai-responses"> {
	return {
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			...(webSearchPerCall === undefined ? {} : { webSearchPerCall }),
		},
		contextWindow: 128000,
		maxTokens: 32000,
	};
}

function createContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "Find the latest headline.",
				timestamp: Date.now(),
			},
		],
		tools: [],
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
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
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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

describe("openai-responses native web_search gating", () => {
	it("does not inject web_search when opt-in is disabled", () => {
		const supportedModel = getModel("openai", "gpt-5.3-codex");
		const params = buildParams(supportedModel, createContext());
		expect(params.tools).toBeUndefined();
		expect(params.include).toBeUndefined();
	});

	it("does not inject web_search for unsupported models even when opt-in is enabled", () => {
		const unsupportedModel = getModel("openai", "gpt-4.1-nano");
		const params = buildParams(unsupportedModel, createContext(), { enableNativeWebSearch: true });
		expect(params.tools).toBeUndefined();
		expect(params.include).toBeUndefined();
	});

	it("injects web_search for gpt-4.1 when opt-in is enabled", () => {
		const supportedModel = getModel("openai", "gpt-4.1");
		const params = buildParams(supportedModel, createContext(), { enableNativeWebSearch: true });
		expect(params.tools?.some((tool) => tool.type === "web_search")).toBe(true);
		expect(params.include).toContain("web_search_call.results");
		expect(params.include).toContain("web_search_call.action.sources");
	});

	it("injects web_search for o4-mini when opt-in is enabled", () => {
		const supportedModel = getModel("openai", "o4-mini");
		const params = buildParams(supportedModel, createContext(), { enableNativeWebSearch: true });
		expect(params.tools?.some((tool) => tool.type === "web_search")).toBe(true);
		expect(params.include).toContain("web_search_call.results");
		expect(params.include).toContain("web_search_call.action.sources");
	});

	it("does not inject web_search for gpt-5 with reasoningEffort minimal", () => {
		const supportedModel = getModel("openai", "gpt-5.3-codex");
		const params = buildParams(supportedModel, createContext(), {
			enableNativeWebSearch: true,
			reasoningEffort: "minimal",
		});
		expect(params.tools).toBeUndefined();
		expect(params.include).not.toContain("web_search_call.results");
		expect(params.include).not.toContain("web_search_call.action.sources");
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	it("injects web_search only when opt-in is enabled on supported models", () => {
		const supportedModel = getModel("openai", "gpt-5.3-codex");
		const params = buildParams(supportedModel, createContext(), { enableNativeWebSearch: true });
		expect(params.tools?.some((tool) => tool.type === "web_search")).toBe(true);
		expect(params.include).toContain("web_search_call.results");
		expect(params.include).toContain("web_search_call.action.sources");
	});
});

describe("openai-responses web_search stream parsing", () => {
	it("keeps stable content indices during interleaved reasoning and web_search events", async () => {
		const model = createModel(0.01);
		const output = createOutput(model);
		const emitted: AssistantMessageEvent[] = [];
		const sink = {
			push(event: AssistantMessageEvent) {
				emitted.push(event);
			},
		} as unknown as AssistantMessageEventStream;

		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				item: { type: "reasoning", id: "rs_1", summary: [] },
			} as unknown as ResponseStreamEvent,
			{
				type: "response.reasoning_summary_part.added",
				part: { type: "summary_text", text: "" },
			} as unknown as ResponseStreamEvent,
			{ type: "response.reasoning_summary_text.delta", delta: "alpha" } as unknown as ResponseStreamEvent,
			{
				type: "response.web_search_call.in_progress",
				item_id: "ws_1",
				sequence_number: 1,
			} as unknown as ResponseStreamEvent,
			{ type: "response.reasoning_summary_text.delta", delta: "beta" } as unknown as ResponseStreamEvent,
			{
				type: "response.web_search_call.completed",
				item_id: "ws_1",
				sequence_number: 1,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "alphabeta" }] },
			} as unknown as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				item: {
					type: "web_search_call",
					id: "ws_1",
					action: { type: "search", query: "latest headline" },
					results: [{ url: "https://example.com" }],
				},
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
					},
				},
			} as unknown as ResponseStreamEvent,
		];

		await processResponsesStream(toAsyncIterable(events), output, sink, model);

		const reasoningDeltas = emitted.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
				event.type === "thinking_delta" && (event.delta === "alpha" || event.delta === "beta"),
		);
		expect(reasoningDeltas).toHaveLength(2);
		expect(reasoningDeltas[0].contentIndex).toBe(0);
		expect(reasoningDeltas[1].contentIndex).toBe(0);

		const webStatusDeltas = emitted.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
				event.type === "thinking_delta" && event.delta.startsWith("Web search"),
		);
		expect(webStatusDeltas.length).toBeGreaterThan(0);
		for (const statusDelta of webStatusDeltas) {
			expect(statusDelta.contentIndex).toBe(1);
		}

		expect(output.usage.webSearchCalls).toBe(1);
		expect(output.usage.cost.webSearch).toBe(0.01);
		expect(output.usage.cost.total).toBe(0.01);
	});
});
