import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../src/types.js";

const generateContentStreamMock = vi.fn();

vi.mock("@google/genai", () => {
	class MockGoogleGenAI {
		models = {
			generateContentStream: generateContentStreamMock,
		};
	}

	return {
		GoogleGenAI: MockGoogleGenAI,
		FunctionCallingConfigMode: {
			AUTO: "AUTO",
			NONE: "NONE",
			ANY: "ANY",
		},
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
		},
	};
});

import { streamGoogle } from "../src/providers/google.js";

function createGoogleModel(): Model<"google-generative-ai"> {
	return {
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	generateContentStreamMock.mockReset();
});

describe("google native web search", () => {
	it("injects native web search tool and emits search signals with stable indexes", async () => {
		generateContentStreamMock.mockResolvedValue(
			(async function* () {
				yield {
					candidates: [
						{
							content: {
								parts: [
									{ text: "Before. " },
									{ googleSearchCall: { query: "latest typescript release" } },
									{ text: "After." },
								],
							},
							groundingMetadata: {
								webSearchQueries: ["latest typescript release"],
								groundingChunks: [{ web: { title: "TypeScript", uri: "https://www.typescriptlang.org" } }],
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 5,
						totalTokenCount: 15,
					},
				};
			})(),
		);

		const payloads: unknown[] = [];
		const context: Context = {
			messages: [{ role: "user", content: "Find latest TypeScript release", timestamp: Date.now() }],
		};

		const stream = streamGoogle(createGoogleModel(), context, {
			apiKey: "token",
			enableNativeWebSearch: true,
			onPayload: (payload) => {
				payloads.push(payload);
			},
		});

		const indexes: number[] = [];
		let thinkingStarts = 0;
		for await (const event of stream) {
			if ("contentIndex" in event) {
				indexes.push(event.contentIndex);
			}
			if (event.type === "thinking_start") {
				thinkingStarts += 1;
			}
		}

		const result = await stream.result();
		expect(payloads).toHaveLength(1);
		const payload = payloads[0] as { config?: { tools?: unknown[] } };
		expect(payload.config?.tools).toEqual([{ googleSearch: {} }]);
		expect(indexes.every((value, index) => index === 0 || value >= indexes[index - 1]!)).toBe(true);
		expect(thinkingStarts).toBeGreaterThanOrEqual(2);
		expect(result.usage.webSearchCalls).toBeGreaterThanOrEqual(2);
		expect(result.stopReason).toBe("stop");
	});
});
