import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { buildRestartArguments, formatRecoveryCommand } from "../src/cli/restart-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("exact-session restart", () => {
	test("parses the internal exact leaf and restart marker", () => {
		const parsed = parseArgs(["--session", "/tmp/session.jsonl", "--session-leaf", "leaf-1", "--restart-session"]);
		expect(parsed.sessionLeaf).toBe("leaf-1");
		expect(parsed.restartSession).toBe(true);
	});

	test("sanitizes launch arguments and appends deterministic session selectors", () => {
		const args = buildRestartArguments(
			[
				"--model",
				"openai/gpt",
				"--session",
				"old.jsonl",
				"--resume",
				"--print",
				"prompt",
				"@file",
				"--theme",
				"dark",
			],
			"/tmp/new session.jsonl",
			"session-2",
			"leaf-2",
		);
		expect(args).toEqual([
			"--model",
			"openai/gpt",
			"--theme",
			"dark",
			"--session",
			"/tmp/new session.jsonl",
			"--session-id",
			"session-2",
			"--session-leaf",
			"leaf-2",
			"--restart-session",
		]);
	});

	test("omits the leaf selector for an empty session", () => {
		expect(buildRestartArguments([], "/tmp/session.jsonl", "session-1", null)).toEqual([
			"--session",
			"/tmp/session.jsonl",
			"--session-id",
			"session-1",
			"--restart-session",
		]);
	});

	test("drops equal-form selectors and preserves only registered extension flags", () => {
		expect(
			buildRestartArguments(
				[
					"--session=old.jsonl",
					"--session-id=wrong",
					"--session-leaf=old-leaf",
					"--print=prompt",
					"--unknown=value",
					"--plan=review",
					"--trace",
					"prompt input",
					"@prompt.md",
				],
				"/tmp/session.jsonl",
				"session-1",
				null,
				[
					{ name: "plan", type: "string", extensionPath: "/tmp/plan.ts" },
					{ name: "trace", type: "boolean", extensionPath: "/tmp/trace.ts" },
				],
			),
		).toEqual([
			"--plan=review",
			"--trace",
			"--session",
			"/tmp/session.jsonl",
			"--session-id",
			"session-1",
			"--restart-session",
		]);
	});

	test("selects a non-tip leaf without appending an entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-restart-"));
		tempDirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		const first = manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "tip" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const entryCount = manager.getEntries().length;
		manager.branch(first);
		expect(manager.getLeafId()).toBe(first);
		expect(manager.getEntries()).toHaveLength(entryCount);
	});

	test("renders a shell-safe recovery command", () => {
		expect(formatRecoveryCommand("node", ["pi.js", "--session", "/tmp/a'b.jsonl"])).toBe(
			"'node' 'pi.js' '--session' '/tmp/a'\\''b.jsonl'",
		);
	});
});
