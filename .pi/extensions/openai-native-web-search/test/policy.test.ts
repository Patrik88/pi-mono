import { describe, expect, it } from "vitest";
import { evaluateNativeWebSearchPolicy } from "../policy.js";

const openAiModel = {
	id: "gpt-5-mini",
	provider: "openai",
	api: "openai-responses",
} as const;

const codexModel = {
	id: "gpt-5.1-codex",
	provider: "openai-codex",
	api: "openai-codex-responses",
} as const;

describe("native web search policy", () => {
	it("enables for supported OpenAI Responses model when opted in", () => {
		expect(evaluateNativeWebSearchPolicy(openAiModel, "low", true)).toEqual({ enabled: true });
	});

	it("disables when not opted in", () => {
		expect(evaluateNativeWebSearchPolicy(openAiModel, "low", false)).toEqual({
			enabled: false,
			reason: "not_opted_in",
		});
	});

	it("disables unsupported model gpt-4.1-nano", () => {
		expect(
			evaluateNativeWebSearchPolicy(
				{ id: "gpt-4.1-nano", provider: "openai", api: "openai-responses" },
				"low",
				true,
			),
		).toEqual({
			enabled: false,
			reason: "unsupported_model",
		});
	});

	it("disables GPT-5 family with minimal reasoning", () => {
		expect(evaluateNativeWebSearchPolicy(openAiModel, "minimal", true)).toEqual({
			enabled: false,
			reason: "gpt5_minimal_reasoning",
		});
	});

	it("allows GPT-5 family with low reasoning or higher", () => {
		expect(evaluateNativeWebSearchPolicy(openAiModel, "low", true)).toEqual({ enabled: true });
		expect(evaluateNativeWebSearchPolicy(codexModel, "high", true)).toEqual({ enabled: true });
	});
});
