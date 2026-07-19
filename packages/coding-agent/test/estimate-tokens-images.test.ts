import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/compaction/compaction.js";

type EstimableMessage = Parameters<typeof estimateTokens>[0];

const imageBlock = { type: "image" as const, data: "base64", mimeType: "image/png" };
type TestTextBlock = { type: "text"; text: string };
type TestImageBlock = typeof imageBlock;
type TestUserContent = string | (TestTextBlock | TestImageBlock)[];

function userMessage(content: TestUserContent): EstimableMessage {
	return { role: "user", content, timestamp: 0 };
}

describe("estimateTokens image blocks", () => {
	it("counts text-only user messages with the text heuristic", () => {
		expect(estimateTokens(userMessage("abcdefgh"))).toBe(2);
	});

	it("counts user image blocks with the shared image heuristic", () => {
		expect(estimateTokens(userMessage([imageBlock]))).toBe(1200);
	});

	it("counts mixed user text and image blocks", () => {
		expect(estimateTokens(userMessage([{ type: "text", text: "abcdefgh" }, imageBlock]))).toBe(1202);
	});

	it("counts tool result image blocks with the shared image heuristic", () => {
		const message: EstimableMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "screenshot",
			content: [imageBlock],
			isError: false,
			timestamp: 0,
		};

		expect(estimateTokens(message)).toBe(1200);
	});

	it("counts custom image blocks with the shared image heuristic", () => {
		const message: EstimableMessage = {
			role: "custom",
			customType: "image-context",
			content: [imageBlock],
			display: true,
			timestamp: 0,
		};

		expect(estimateTokens(message)).toBe(1200);
	});

	it("counts multiple images in one message", () => {
		expect(estimateTokens(userMessage([imageBlock, imageBlock]))).toBe(2400);
	});
});
