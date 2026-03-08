import { describe, expect, it } from "vitest";
import type { ModelWithWebSearchCost, UsageWithWebSearch } from "../types.js";
import { applyWebSearchPricing, DEFAULT_WEB_SEARCH_PER_CALL } from "../pricing.js";

function createModel(id: string): ModelWithWebSearchCost<"openai-responses"> {
	return {
		id,
		name: id,
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

function createUsage(webSearchCalls?: number): UsageWithWebSearch {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		webSearchCalls,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0, total: 0 },
	};
}

describe("web search pricing", () => {
	it("counts webSearchCalls and applies per-call cost", () => {
		const usage = createUsage(3);
		applyWebSearchPricing(createModel("gpt-5-mini"), usage);
		expect(usage.cost.webSearch).toBe(3 * DEFAULT_WEB_SEARCH_PER_CALL);
		expect(usage.cost.total).toBe(3 * DEFAULT_WEB_SEARCH_PER_CALL);
	});

	it("keeps zero cost when there are no web search calls", () => {
		const usage = createUsage(0);
		applyWebSearchPricing(createModel("gpt-5-mini"), usage);
		expect(usage.cost.webSearch).toBe(0);
		expect(usage.cost.total).toBe(0);
	});
});
