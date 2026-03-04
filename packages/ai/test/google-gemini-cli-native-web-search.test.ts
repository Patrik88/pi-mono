import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRequest, streamGoogleGeminiCli } from "../src/providers/google-gemini-cli.js";
import type { Context, Model, Tool } from "../src/types.js";

const originalFetch = global.fetch;
const apiKey = JSON.stringify({ token: "token", projectId: "project" });

function createSseResponse(chunks: unknown[]): Response {
	const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(payload));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createModel(
	provider: "google-gemini-cli" | "google-antigravity" = "google-gemini-cli",
): Model<"google-gemini-cli"> {
	return {
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-gemini-cli",
		provider,
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("google-gemini-cli native web search request injection", () => {
	const context: Context = {
		messages: [{ role: "user", content: "What happened today?", timestamp: Date.now() }],
	};

	it("injects googleSearch tool when opted in and supported", () => {
		const model = createModel();
		const request = buildRequest(model, context, "project", { enableNativeWebSearch: true });
		expect(request.request.tools).toEqual([{ googleSearch: {} }]);
	});

	it("keeps behavior unchanged when opt-in is disabled", () => {
		const model = createModel();
		const request = buildRequest(model, context, "project", { enableNativeWebSearch: false });
		expect(request.request.tools).toBeUndefined();
	});

	it("combines function declarations with native web search", () => {
		const model = createModel();
		const tool: Tool = {
			name: "echo",
			description: "Echo text",
			parameters: Type.Object({
				value: Type.String(),
			}),
		};
		const request = buildRequest(model, { ...context, tools: [tool] }, "project", { enableNativeWebSearch: true });
		expect(request.request.tools).toHaveLength(2);
		expect(request.request.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("echo");
		expect(request.request.tools?.[1]).toEqual({ googleSearch: {} });
	});
});

describe("google-antigravity native web search fallback", () => {
	it("retries without native search tool and emits warning", async () => {
		const fetchBodies: unknown[] = [];
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			if (init?.body && typeof init.body === "string") {
				fetchBodies.push(JSON.parse(init.body));
			}
			if (fetchBodies.length === 1) {
				return new Response(JSON.stringify({ error: { message: "unsupported tool field googleSearch" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			}
			return createSseResponse([
				{
					response: {
						candidates: [
							{
								content: { role: "model", parts: [{ text: "Fallback succeeded" }] },
								finishReason: "STOP",
							},
						],
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 3,
							totalTokenCount: 8,
						},
					},
				},
			]);
		});
		global.fetch = fetchMock as typeof fetch;

		const stream = streamGoogleGeminiCli(
			createModel("google-antigravity"),
			{ messages: [{ role: "user", content: "Find latest updates", timestamp: Date.now() }] },
			{ apiKey, enableNativeWebSearch: true },
		);

		const thinkingDeltas: string[] = [];
		for await (const event of stream) {
			if (event.type === "thinking_delta") {
				thinkingDeltas.push(event.delta);
			}
		}

		const result = await stream.result();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect((fetchBodies[0] as { request?: { tools?: unknown[] } }).request?.tools).toEqual([{ googleSearch: {} }]);
		expect((fetchBodies[1] as { request?: { tools?: unknown[] } }).request?.tools).toBeUndefined();
		expect(thinkingDeltas.join("\n")).toContain("retrying without native web search");
		expect(result.stopReason).toBe("stop");
		expect(result.content.some((block) => block.type === "text" && block.text.includes("Fallback succeeded"))).toBe(
			true,
		);
	});
});

describe("google-gemini-cli native web search stream parsing", () => {
	it("emits interleaved events with stable contentIndex and tracks webSearchCalls", async () => {
		const fetchMock = vi.fn(async () =>
			createSseResponse([
				{
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ text: "Before search. " },
										{ googleSearchCall: { query: "weather stockholm" } },
										{ text: "After search." },
									],
								},
								groundingMetadata: {
									webSearchQueries: ["weather stockholm"],
									groundingChunks: [{ web: { title: "SMHI", uri: "https://www.smhi.se" } }],
								},
								finishReason: "STOP",
							},
						],
						usageMetadata: {
							promptTokenCount: 9,
							candidatesTokenCount: 6,
							totalTokenCount: 15,
						},
					},
				},
			]),
		);
		global.fetch = fetchMock as typeof fetch;

		const stream = streamGoogleGeminiCli(
			createModel(),
			{ messages: [{ role: "user", content: "Search then summarize", timestamp: Date.now() }] },
			{ apiKey, enableNativeWebSearch: true },
		);

		const contentIndexes: number[] = [];
		const textStarts: number[] = [];
		const thinkingStarts: number[] = [];
		for await (const event of stream) {
			if ("contentIndex" in event) {
				contentIndexes.push(event.contentIndex);
			}
			if (event.type === "text_start") {
				textStarts.push(event.contentIndex);
			}
			if (event.type === "thinking_start") {
				thinkingStarts.push(event.contentIndex);
			}
		}

		const result = await stream.result();
		expect(contentIndexes.every((value, index) => index === 0 || value >= contentIndexes[index - 1]!)).toBe(true);
		expect(textStarts.length).toBeGreaterThanOrEqual(2);
		expect(thinkingStarts.length).toBeGreaterThanOrEqual(2);
		expect(result.usage.webSearchCalls).toBeGreaterThanOrEqual(2);
		expect(result.usage.cost.webSearch).toBe(0);
	});
});
