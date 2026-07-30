import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../coding-agent/src/core/messages.ts";
import { buildSessionContext, type SessionEntry } from "../../coding-agent/src/core/session-manager.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "../src/types.ts";

const INCIDENT_CALL_ID = "toolu_01PLWRr5aidacJz7F8PQzYzg";
const BASE_TIME = Date.UTC(2026, 6, 30, 14, 19, 52);

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "claude-bridge",
		model: "claude-opus-4-6",
		usage,
		stopReason,
		timestamp: BASE_TIME,
	};
}

function messageEntry(id: string, parentId: string | null, message: Message): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(BASE_TIME).toISOString(),
		message,
	};
}

function describeMessages(messages: readonly Message[]): string[] {
	return messages.map((message) => {
		if (message.role === "assistant") {
			const blocks = message.content.map((block) =>
				block.type === "toolCall" ? `toolCall:${block.id}` : block.type,
			);
			return `assistant:${message.stopReason}:[${blocks.join(",")}]`;
		}
		if (message.role === "toolResult") return `toolResult:${message.toolCallId}:error=${message.isError}`;
		return `${message.role}`;
	});
}

function describeResponsesInput(input: ReturnType<typeof convertResponsesMessages>): string[] {
	return input.map((item) => {
		if (item.type === "function_call" || item.type === "function_call_output") {
			return `${item.type}:${item.call_id}`;
		}
		if ("role" in item) return `${item.role}`;
		return String(item.type);
	});
}

function buildFixture(): SessionEntry[] {
	const toolCall = assistant(
		[
			{ type: "text", text: "Collecting the remaining entries." },
			{ type: "toolCall", id: INCIDENT_CALL_ID, name: "bash", arguments: { command: "bounded fixture" } },
		],
		"toolUse",
	);
	const abortedResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: INCIDENT_CALL_ID,
		toolName: "bash",
		content: [{ type: "text", text: "Command aborted" }],
		isError: true,
		timestamp: BASE_TIME + 1,
	};

	return [
		messageEntry("user", null, { role: "user", content: "Inspect the bounded history.", timestamp: BASE_TIME - 1 }),
		messageEntry("tool-call", "user", toolCall),
		messageEntry("tool-result", "tool-call", abortedResult),
		messageEntry("failed-retry", "tool-result", assistant([], "error")),
		messageEntry("bridge-zero-block", "failed-retry", assistant([], "stop")),
	];
}

describe("Claude-to-Codex orphan function_call_output diagnosis", () => {
	it("preserves the foreign tool span through every local projection boundary", async () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const persistedEntries = buildFixture();
		const sessionContext = buildSessionContext(persistedEntries);
		const postContextHook = structuredClone(sessionContext.messages);
		const llmMessages = convertToLlm(postContextHook);
		const transformed = transformMessages(llmMessages, model, (id) => id);
		const responsesInput = convertResponsesMessages(
			model,
			{ systemPrompt: "Keep the investigation bounded.", messages: llmMessages },
			new Set(["openai", "openai-codex", "opencode"]),
			{ includeSystemPrompt: false },
		);
		const codexRequestMetadata = {
			transport: "full-context" as const,
			previous_response_id: undefined,
			inputItems: responsesInput.length,
		};

		expect(
			describeMessages(
				persistedEntries.flatMap((entry) => (entry.type === "message" ? [entry.message as Message] : [])),
			),
		).toEqual([
			"user",
			`assistant:toolUse:[text,toolCall:${INCIDENT_CALL_ID}]`,
			`toolResult:${INCIDENT_CALL_ID}:error=true`,
			"assistant:error:[]",
			"assistant:stop:[]",
		]);
		expect(describeMessages(sessionContext.messages as Message[])).toEqual([
			"user",
			`assistant:toolUse:[text,toolCall:${INCIDENT_CALL_ID}]`,
			`toolResult:${INCIDENT_CALL_ID}:error=true`,
			"assistant:error:[]",
			"assistant:stop:[]",
		]);
		expect(describeMessages(postContextHook as Message[])).toEqual(
			describeMessages(sessionContext.messages as Message[]),
		);
		expect(describeMessages(transformed)).toEqual([
			"user",
			`assistant:toolUse:[text,toolCall:${INCIDENT_CALL_ID}]`,
			`toolResult:${INCIDENT_CALL_ID}:error=true`,
			"assistant:stop:[]",
		]);
		expect(describeResponsesInput(responsesInput)).toEqual([
			"user",
			"assistant",
			`function_call:${INCIDENT_CALL_ID}`,
			`function_call_output:${INCIDENT_CALL_ID}`,
		]);
		expect(codexRequestMetadata).toEqual({
			transport: "full-context",
			previous_response_id: undefined,
			inputItems: 4,
		});
	});

	it("keeps the clean four-message foreign Opus error-result path explicitly paired", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const messages = buildFixture()
			.slice(0, 3)
			.flatMap((entry) => (entry.type === "message" ? [entry.message as Message] : []));
		messages.push({ role: "user", content: "Continue with Codex.", timestamp: BASE_TIME + 2 });

		const input = convertResponsesMessages(model, { messages }, new Set(["openai", "openai-codex", "opencode"]));
		const span = describeResponsesInput(input).filter((item) => item.startsWith("function_call"));

		expect(span).toEqual([`function_call:${INCIDENT_CALL_ID}`, `function_call_output:${INCIDENT_CALL_ID}`]);
	});
});
