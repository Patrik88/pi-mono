import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantToolCall(): AssistantMessage {
	return {
		...assistantText(""),
		content: [{ type: "toolCall", id: "tool-1", name: "slow_tool", arguments: {} }],
		stopReason: "toolUse",
	};
}

describe("AgentSession cooperative pause", () => {
	let session: AgentSession | undefined;
	let tempDir = "";

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-pause-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	async function createPauseSession(
		options: {
			terminateTool?: boolean;
			agentEndAppendMetadata?: boolean;
			agentEndQueueFollowUp?: boolean;
			agentEndRequestPause?: boolean;
		} = {},
	) {
		const toolStarted = deferred();
		const releaseTool = deferred();
		let toolSawAbort = false;
		let requestCount = 0;
		let agentEndCount = 0;
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "slow_tool",
			label: "Slow tool",
			description: "Waits until the test releases it",
			parameters: schema,
			async execute(_toolCallId, _params, signal) {
				toolStarted.resolve();
				await releaseTool.promise;
				toolSawAbort = signal?.aborted === true;
				return {
					content: [{ type: "text", text: "done" }],
					details: {},
					terminate: options.terminateTool,
				};
			},
		};
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [tool] },
			streamFn: () => {
				requestCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = requestCount === 1 ? assistantToolCall() : assistantText("finished");
					stream.push({
						type: "done",
						reason: requestCount === 1 ? "toolUse" : "stop",
						message,
					});
				});
				return stream;
			},
		});
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("agent_end", async (_event, ctx) => {
					agentEndCount++;
					if (agentEndCount !== 1) return;
					if (options.agentEndAppendMetadata) pi.appendEntry("pause-test-metadata", { complete: true });
					if (options.agentEndQueueFollowUp) {
						pi.sendUserMessage("queued during agent_end", { deliverAs: "followUp" });
					}
					if (options.agentEndRequestPause) ctx.requestPause?.();
				});
			},
		]);
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			baseToolsOverride: { slow_tool: tool },
		});

		return {
			context: session.extensionRunner.createContext(),
			sessionManager,
			toolStarted,
			releaseTool,
			requestCount: () => requestCount,
			toolSawAbort: () => toolSawAbort,
		};
	}

	it("waits for the active tool, pauses before the next provider request, and resumes without a user message", async () => {
		const fixture = await createPauseSession();
		const prompt = session!.prompt("start");
		await fixture.toolStarted.promise;

		expect(fixture.context.requestPause?.()).toEqual({
			supported: true,
			state: "pause_requested",
			resumable: false,
		});
		fixture.releaseTool.resolve();
		await prompt;

		expect(fixture.toolSawAbort()).toBe(false);
		expect(fixture.requestCount()).toBe(1);
		expect(fixture.context.getPauseStatus?.()).toEqual({
			supported: true,
			state: "paused",
			resumable: true,
		});
		expect(session!.agent.state.messages[session!.agent.state.messages.length - 1]?.role).toBe("toolResult");

		await fixture.context.resumePausedRun?.();

		expect(fixture.requestCount()).toBe(2);
		expect(fixture.context.getPauseStatus?.()).toEqual({
			supported: true,
			state: "idle",
			resumable: false,
		});
		const userMessages = session!.agent.state.messages.filter((message) => message.role === "user");
		expect(userMessages).toHaveLength(1);
	});

	it("can cancel a pending pause before the safe boundary", async () => {
		const fixture = await createPauseSession();
		const prompt = session!.prompt("start");
		await fixture.toolStarted.promise;

		fixture.context.requestPause?.();
		expect(fixture.context.cancelPauseRequest?.()).toEqual({
			supported: true,
			state: "running",
			resumable: false,
		});
		fixture.releaseTool.resolve();
		await prompt;

		expect(fixture.requestCount()).toBe(2);
		expect(fixture.context.getPauseStatus?.().state).toBe("idle");
	});

	it("captures the continuation leaf after awaited agent_end metadata", async () => {
		const fixture = await createPauseSession({ agentEndAppendMetadata: true });
		const prompt = session!.prompt("start");
		await fixture.toolStarted.promise;
		fixture.context.requestPause?.();
		fixture.releaseTool.resolve();
		await prompt;

		expect(fixture.context.getPauseStatus?.()).toEqual({
			supported: true,
			state: "paused",
			resumable: true,
		});
		await fixture.context.resumePausedRun?.();
		expect(fixture.requestCount()).toBe(2);
	});

	it("pauses queued work added by an awaited agent_end handler", async () => {
		const fixture = await createPauseSession({ agentEndQueueFollowUp: true });
		const prompt = session!.prompt("start");
		await fixture.toolStarted.promise;
		fixture.context.requestPause?.();
		fixture.releaseTool.resolve();
		await prompt;

		expect(fixture.requestCount()).toBe(1);
		expect(fixture.context.getPauseStatus?.().state).toBe("paused");
		await fixture.context.resumePausedRun?.();
		expect(fixture.requestCount()).toBe(3);
	});

	it("does not manufacture a continuation after a terminating tool batch", async () => {
		const fixture = await createPauseSession({
			terminateTool: true,
			agentEndRequestPause: true,
		});
		const prompt = session!.prompt("start");
		await fixture.toolStarted.promise;
		fixture.releaseTool.resolve();
		await prompt;

		expect(fixture.requestCount()).toBe(1);
		expect(fixture.context.getPauseStatus?.()).toEqual({
			supported: true,
			state: "idle",
			resumable: false,
		});
		await expect(fixture.context.resumePausedRun?.()).rejects.toThrow(
			"No paused agent run is available to continue.",
		);
	});

	it("refuses continuation after the paused branch changes", async () => {
		const fixture = await createPauseSession();
		const prompt = session!.prompt("start");
		await fixture.toolStarted.promise;
		fixture.context.requestPause?.();
		fixture.releaseTool.resolve();
		await prompt;

		fixture.sessionManager.appendCustomEntry("test-drift", { changed: true });
		expect(fixture.context.getPauseStatus?.()).toEqual({
			supported: true,
			state: "paused",
			resumable: false,
			staleReason: "branch",
		});
		await expect(fixture.context.resumePausedRun?.()).rejects.toThrow(
			"The session branch changed after the pause; the paused run cannot be continued.",
		);
	});
});
