import { describe, expect, it } from "vitest";
import type { Context, Model } from "../../../../packages/ai/src/types.js";
import { buildCodexRequestBody } from "../openai-codex-provider.js";
import { buildOpenAIResponsesParams } from "../openai-provider.js";
import { appendNativeWebSearchDirective } from "../state.js";

function createContext(): Context {
	return {
		systemPrompt: appendNativeWebSearchDirective("You are helpful."),
		messages: [{ role: "user", content: "Search the web", timestamp: Date.now() }],
		tools: [],
	};
}

function createOpenAIModel(id: string): Model<"openai-responses"> {
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

function createCodexModel(id: string): Model<"openai-codex-responses"> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

describe("codex parity", () => {
	it("uses the same enable/disable reasoning policy", () => {
		const openAiDecision = buildOpenAIResponsesParams(createOpenAIModel("gpt-5-mini"), createContext(), {
			reasoningEffort: "minimal",
		}).decision;
		const codexDecision = buildCodexRequestBody(createCodexModel("gpt-5.1-codex"), createContext(), {
			reasoningEffort: "minimal",
		}).decision;

		expect(openAiDecision).toEqual({ enabled: false, reason: "gpt5_minimal_reasoning" });
		expect(codexDecision).toEqual({ enabled: false, reason: "gpt5_minimal_reasoning" });
	});

	it("uses the same request injection semantics when enabled", () => {
		const openAi = buildOpenAIResponsesParams(createOpenAIModel("gpt-5-mini"), createContext(), {
			reasoningEffort: "low",
		});
		const codex = buildCodexRequestBody(createCodexModel("gpt-5.1-codex"), createContext(), {
			reasoningEffort: "low",
		});

		expect(openAi.decision.enabled).toBe(true);
		expect(codex.decision.enabled).toBe(true);
		expect(openAi.params.tools?.some((tool) => tool.type === "web_search")).toBe(true);
		expect(codex.body.tools?.some((tool) => tool.type === "web_search")).toBe(true);
		expect(openAi.params.include).toContain("web_search_call.results");
		expect(codex.body.include).toContain("web_search_call.results");
	});
});
