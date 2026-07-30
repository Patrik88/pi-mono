import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { loadExtensions } from "../../coding-agent/src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../coding-agent/src/core/extensions/runner.ts";
import { convertToLlm } from "../../coding-agent/src/core/messages.ts";
import { buildSessionContext, type SessionEntry, SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../../coding-agent/test/model-runtime-test-utils.ts";
import {
	closeOpenAICodexWebSocketSessions,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
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

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	provider: string,
	api: AssistantMessage["api"],
	model: string,
): AssistantMessage {
	return { role: "assistant", content, api, provider, model, usage, stopReason, timestamp: BASE_TIME };
}

function bridgeAssistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return assistant(content, stopReason, "claude-bridge", "anthropic-messages", "claude-opus-4-6");
}

function codexAssistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return assistant([], stopReason, "openai-codex", "openai-codex-responses", "gpt-5.5");
}

function messageEntry(id: string, parentId: string | null, message: Message): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(BASE_TIME).toISOString(), message };
}

function describeMessages(messages: readonly Message[]): string[] {
	return messages.map((message) => {
		if (message.role === "assistant") {
			const blocks = message.content.map((block) =>
				block.type === "toolCall" ? `toolCall:${block.id}` : block.type,
			);
			return `assistant:${message.provider}/${message.model}:${message.stopReason}:[${blocks.join(",")}]`;
		}
		if (message.role === "toolResult") return `toolResult:${message.toolCallId}:error=${message.isError}`;
		return `${message.role}`;
	});
}

function describeResponsesInput(input: readonly unknown[]): string[] {
	return input.map((item) => {
		if (typeof item !== "object" || item === null) return String(item);
		const record = item as { type?: unknown; call_id?: unknown; role?: unknown };
		if (record.type === "function_call" || record.type === "function_call_output") {
			return `${record.type}:${String(record.call_id)}`;
		}
		if (record.role !== undefined) return String(record.role);
		return String(record.type);
	});
}

function buildFixture(): SessionEntry[] {
	const toolCall = bridgeAssistant(
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
		{
			type: "model_change",
			id: "model-change",
			parentId: "tool-result",
			timestamp: new Date(BASE_TIME + 2).toISOString(),
			provider: "openai-codex",
			modelId: "gpt-5.5",
		},
		messageEntry("failed-codex-retry", "model-change", codexAssistant("error")),
		messageEntry("bridge-zero-block", "failed-codex-retry", bridgeAssistant([], "stop")),
	];
}

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

afterEach(() => {
	vi.unstubAllGlobals();
	closeOpenAICodexWebSocketSessions();
});

describe("Claude-to-Codex orphan function_call_output diagnosis", () => {
	it("preserves the foreign tool span through the real context hook and Codex request pipelines", async () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const persistedEntries = buildFixture();
		const sessionContext = buildSessionContext(persistedEntries);
		const tempDir = mkdtempSync(join(tmpdir(), "pi-tool-span-diagnosis-"));
		const extensionPath = join(tempDir, "noop-context.ts");
		writeFileSync(
			extensionPath,
			"export default (pi) => pi.on('context', async (event) => ({ messages: event.messages }));\n",
		);

		let postContextHook: Message[];
		try {
			const loaded = await loadExtensions([extensionPath], tempDir);
			expect(loaded.errors).toEqual([]);
			const authStorage = AuthStorage.inMemory();
			const modelRegistry = await createInMemoryModelRegistry(authStorage);
			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				SessionManager.inMemory(tempDir),
				modelRegistry,
			);
			postContextHook = (await runner.emitContext(sessionContext.messages, sessionContext.items)) as Message[];
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}

		const llmMessages = convertToLlm(postContextHook);
		const transformed = transformMessages(llmMessages, model, (id) => id);
		const responsesInput = convertResponsesMessages(
			model,
			{ systemPrompt: "Keep the investigation bounded.", messages: llmMessages },
			new Set(["openai", "openai-codex", "opencode"]),
			{ includeSystemPrompt: false },
		);

		const sentBodies: Array<{ input: Array<Record<string, unknown>>; previous_response_id?: string }> = [];
		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor() {
				queueMicrotask(() => this.dispatch("open", {}));
			}
			addEventListener(type: string, listener: (event: unknown) => void): void {
				const listeners = this.listeners.get(type) ?? new Set();
				listeners.add(listener);
				this.listeners.set(type, listeners);
			}
			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}
			send(data: string): void {
				sentBodies.push(JSON.parse(data) as (typeof sentBodies)[number]);
				const responseId = `resp_${sentBodies.length}`;
				queueMicrotask(() =>
					this.dispatch("message", {
						data: JSON.stringify({
							type: "response.completed",
							response: {
								id: responseId,
								status: "completed",
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						}),
					}),
				);
			}
			close(): void {}
			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);

		const requestContext = { systemPrompt: "Keep the investigation bounded.", messages: llmMessages };
		await streamOpenAICodexResponses(model, requestContext, {
			apiKey: mockToken(),
			sessionId: "tool-span-diagnosis",
			transport: "websocket-cached",
		}).result();
		await streamOpenAICodexResponses(
			{
				...model,
			},
			{
				...requestContext,
				messages: [...llmMessages, { role: "user", content: "Continue with Codex.", timestamp: BASE_TIME + 3 }],
			},
			{
				apiKey: mockToken(),
				sessionId: "tool-span-diagnosis",
				transport: "websocket-cached",
			},
		).result();

		expect(
			persistedEntries.map((entry) => {
				if (entry.type === "model_change") return `model_change:${entry.provider}/${entry.modelId}`;
				if (entry.type === "message") return describeMessages([entry.message as Message])[0];
				return entry.type;
			}),
		).toEqual([
			"user",
			`assistant:claude-bridge/claude-opus-4-6:toolUse:[text,toolCall:${INCIDENT_CALL_ID}]`,
			`toolResult:${INCIDENT_CALL_ID}:error=true`,
			"model_change:openai-codex/gpt-5.5",
			"assistant:openai-codex/gpt-5.5:error:[]",
			"assistant:claude-bridge/claude-opus-4-6:stop:[]",
		]);
		expect(describeMessages(postContextHook)).toEqual(describeMessages(sessionContext.messages as Message[]));
		expect(describeMessages(transformed)).toEqual([
			"user",
			`assistant:claude-bridge/claude-opus-4-6:toolUse:[text,toolCall:${INCIDENT_CALL_ID}]`,
			`toolResult:${INCIDENT_CALL_ID}:error=true`,
			"assistant:claude-bridge/claude-opus-4-6:stop:[]",
		]);
		expect(describeResponsesInput(responsesInput)).toEqual([
			"user",
			"assistant",
			`function_call:${INCIDENT_CALL_ID}`,
			`function_call_output:${INCIDENT_CALL_ID}`,
		]);
		expect(sentBodies).toHaveLength(2);
		expect(sentBodies[0]?.previous_response_id).toBeUndefined();
		expect(describeResponsesInput(sentBodies[0]?.input ?? [])).toEqual([
			"user",
			"assistant",
			`function_call:${INCIDENT_CALL_ID}`,
			`function_call_output:${INCIDENT_CALL_ID}`,
		]);
		expect(sentBodies[1]?.previous_response_id).toBe("resp_1");
		expect(describeResponsesInput(sentBodies[1]?.input ?? [])).toEqual(["user"]);
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
