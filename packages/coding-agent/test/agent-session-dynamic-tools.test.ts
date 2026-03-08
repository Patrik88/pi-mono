import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("AgentSession dynamic tool registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("refreshes tool registry when tools are registered after initialization", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							promptGuidelines: ["Use dynamic_tool when the user asks for dynamic behavior tests."],
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("dynamic_tool");

		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toContain("dynamic_tool");
		expect(session.getActiveToolNames()).toContain("dynamic_tool");
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).toContain("- Use dynamic_tool when the user asks for dynamic behavior tests.");

		session.dispose();
	});

	it("runs session_start and session_switch hooks end-to-end", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const hookEvents: string[] = [];

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						hookEvents.push("session_start");
						pi.registerTool({
							name: "startup_hook_tool",
							label: "Startup Hook Tool",
							description: "Tool registered from session_start",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "startup" }],
								details: {},
							}),
						});
					});

					pi.on("session_switch", (event) => {
						hookEvents.push(`session_switch:${event.reason}`);
						pi.registerTool({
							name: `switch_${event.reason}_hook_tool`,
							label: `Switch ${event.reason} Hook Tool`,
							description: `Tool registered from session_switch (${event.reason})`,
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: event.reason }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("startup_hook_tool");
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("switch_new_hook_tool");
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("switch_resume_hook_tool");

		await session.bindExtensions({});

		expect(hookEvents).toEqual(["session_start"]);
		expect(session.getAllTools().map((tool) => tool.name)).toContain("startup_hook_tool");
		expect(session.getActiveToolNames()).toContain("startup_hook_tool");
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("switch_new_hook_tool");

		const initialSessionFile = session.sessionFile;
		await session.newSession();

		expect(hookEvents).toEqual(["session_start", "session_switch:new"]);
		expect(session.getAllTools().map((tool) => tool.name)).toContain("switch_new_hook_tool");
		expect(session.getActiveToolNames()).toContain("switch_new_hook_tool");
		expect(session.sessionFile).not.toBe(initialSessionFile);

		const resumeTarget = join(tempDir, "sessions", "resume-target.jsonl");
		await session.switchSession(resumeTarget);

		expect(hookEvents).toEqual(["session_start", "session_switch:new", "session_switch:resume"]);
		expect(session.getAllTools().map((tool) => tool.name)).toContain("switch_resume_hook_tool");
		expect(session.getActiveToolNames()).toContain("switch_resume_hook_tool");
		expect(session.sessionFile).toBe(resumeTarget);

		session.dispose();
	});
});
