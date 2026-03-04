import type { Part } from "@google/genai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
	convertTools,
	extractNativeWebSearchSignalsFromGroundingMetadata,
	extractNativeWebSearchSignalsFromPart,
} from "../src/providers/google-shared.js";
import type { Tool } from "../src/types.js";

describe("google-shared native web search tools", () => {
	const tools: Tool[] = [
		{
			name: "echo",
			description: "Echoes text",
			parameters: Type.Object({ value: Type.String() }),
		},
	];

	it("returns undefined when no tools are enabled", () => {
		expect(convertTools([])).toBeUndefined();
	});

	it("injects googleSearch tool without function declarations", () => {
		const converted = convertTools([], { enableNativeWebSearch: true });
		expect(converted).toEqual([{ googleSearch: {} }]);
	});

	it("keeps function declarations and appends googleSearch", () => {
		const converted = convertTools(tools, { enableNativeWebSearch: true });
		expect(converted).toHaveLength(2);
		expect(converted?.[0]?.functionDeclarations?.[0]?.name).toBe("echo");
		expect(converted?.[1]).toEqual({ googleSearch: {} });
	});
});

describe("google-shared native web search signal parsing", () => {
	it("extracts search call and result signals from parts", () => {
		const partWithCall = { googleSearchCall: { query: "weather stockholm" } } as unknown as Part;
		const callSignals = extractNativeWebSearchSignalsFromPart(partWithCall);
		expect(callSignals).toHaveLength(1);
		expect(callSignals[0]?.webSearchCallsIncrement).toBe(1);
		expect(callSignals[0]?.message).toContain("weather stockholm");

		const partWithResult = {
			googleSearchResult: {
				results: [{ title: "SMHI", uri: "https://www.smhi.se" }],
			},
		} as unknown as Part;
		const resultSignals = extractNativeWebSearchSignalsFromPart(partWithResult);
		expect(resultSignals).toHaveLength(1);
		expect(resultSignals[0]?.webSearchCallsIncrement).toBe(0);
		expect(resultSignals[0]?.message).toContain("SMHI");
	});

	it("extracts query/source signals from grounding metadata", () => {
		const signals = extractNativeWebSearchSignalsFromGroundingMetadata({
			webSearchQueries: ["latest npm typescript"],
			groundingChunks: [
				{
					web: {
						title: "TypeScript",
						uri: "https://www.typescriptlang.org",
					},
				},
			],
		});

		expect(signals).toHaveLength(2);
		expect(signals.some((signal) => signal.message.includes("latest npm typescript"))).toBe(true);
		expect(signals.some((signal) => signal.message.includes("TypeScript"))).toBe(true);
	});
});
