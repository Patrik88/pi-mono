import { describe, expect, it } from "vitest";
import type { Context, Model } from "../../../../packages/ai/src/types.js";
import { buildCodexRequestBody } from "../openai-codex-provider.js";
import { buildOpenAIResponsesParams } from "../openai-provider.js";
import { appendNativeWebSearchDirective } from "../state.js";

function createContext(optedIn: boolean): Context {
	return {
		systemPrompt: optedIn ? appendNativeWebSearchDirective("You are helpful.") : "You are helpful.",
		messages: [{ role: "user", content: "Find the latest headline.", timestamp: Date.now() }],
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

describe("request injection", () => {
	it("injects native web search for OpenAI Responses when enabled", () => {
		const { params, decision, context } = buildOpenAIResponsesParams(createOpenAIModel("gpt-5-mini"), createContext(true), {
			reasoningEffort: "low",
		});
		expect(decision.enabled).toBe(true);
		expect(context.systemPrompt).toBe("You are helpful.");
		expect(params.tools?.some((tool) => tool.type === "web_search")).toBe(true);
		expect(params.include).toContain("web_search_call.results");
		expect(params.include).toContain("web_search_call.action.sources");
	});

	it("does not inject native web search when disabled", () => {
		const { params, decision } = buildOpenAIResponsesParams(createOpenAIModel("gpt-5-mini"), createContext(false), {
			reasoningEffort: "low",
		});
		expect(decision.enabled).toBe(false);
		expect(params.tools).toBeUndefined();
		expect(params.include).toContain("reasoning.encrypted_content");
		expect(params.include).not.toContain("web_search_call.results");
	});

	it("does not inject native web search for GPT-5 minimal reasoning", () => {
		const { params, decision } = buildOpenAIResponsesParams(createOpenAIModel("gpt-5-mini"), createContext(true), {
			reasoningEffort: "minimal",
		});
		expect(decision).toEqual({ enabled: false, reason: "gpt5_minimal_reasoning" });
		expect(params.tools).toBeUndefined();
		expect(params.include).toContain("reasoning.encrypted_content");
		expect(params.include).not.toContain("web_search_call.results");
	});

	it("injects native web search for Codex when enabled", () => {
		const { body, decision, context } = buildCodexRequestBody(createCodexModel("gpt-5.1-codex"), createContext(true), {
			reasoningEffort: "low",
		});
		expect(decision.enabled).toBe(true);
		expect(context.systemPrompt).toBe("You are helpful.");
		expect(body.tools?.some((tool) => tool.type === "web_search")).toBe(true);
		expect(body.include).toContain("reasoning.encrypted_content");
		expect(body.include).toContain("web_search_call.results");
		expect(body.include).toContain("web_search_call.action.sources");
	});
});
