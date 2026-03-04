import { describe, expect, it } from "vitest";
import { calculateCost, getModel, shouldEnableNativeWebSearch, supportsNativeWebSearch } from "../src/models.js";
import type { Model, Usage } from "../src/types.js";

describe("native provider web search policy", () => {
	it("supports Gemini models and rejects non-Gemini Google models", () => {
		const geminiModel = getModel("google", "gemini-2.5-flash");
		expect(supportsNativeWebSearch(geminiModel)).toBe(true);

		const antigravityClaude = getModel("google-antigravity", "claude-sonnet-4-5");
		expect(supportsNativeWebSearch(antigravityClaude)).toBe(false);
	});

	it("supports OpenAI reasoning families for native provider web search", () => {
		const openaiModel = getModel("openai", "gpt-5-mini");
		expect(supportsNativeWebSearch(openaiModel)).toBe(true);
	});

	it("requires explicit opt-in flag", () => {
		const model = getModel("google", "gemini-2.5-flash");
		expect(shouldEnableNativeWebSearch(model, false)).toBe(false);
		expect(shouldEnableNativeWebSearch(model, undefined)).toBe(false);
		expect(shouldEnableNativeWebSearch(model, true)).toBe(true);
	});
});

describe("calculateCost native web search", () => {
	it("adds web search cost when call count tracking is present", () => {
		const model: Model<"google-generative-ai"> = {
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0, webSearchPerCall: 0.5 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const usage: Usage = {
			input: 1000,
			output: 2000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3000,
			webSearchCalls: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage);
		expect(usage.cost.webSearch).toBe(1);
		expect(usage.cost.total).toBeCloseTo(1.018, 6);
	});

	it("does not add web search key when tracking is not used", () => {
		const model: Model<"google-generative-ai"> = {
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const usage: Usage = {
			input: 1000,
			output: 2000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage);
		expect(usage.cost.webSearch).toBeUndefined();
		expect(usage.cost.total).toBeCloseTo(0.018, 6);
	});
});
