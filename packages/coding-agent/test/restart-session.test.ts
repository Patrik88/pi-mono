import { type ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import {
	buildRestartArguments,
	formatRecoveryCommand,
	preflightRestart,
	superviseReplacementProcess,
} from "../src/cli/restart-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];
const testDir = dirname(fileURLToPath(import.meta.url));
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

	test("fails preflight before teardown when the session file is unavailable", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-restart-preflight-"));
		tempDirs.push(dir);
		expect(() => preflightRestart(join(dir, "missing.jsonl"), dir)).toThrow();
	});

	test("reports a deterministic spawn failure without losing the recovery command", async () => {
		const child = new EventEmitter();
		const failure = new Error("spawn refused");
		const promise = superviseReplacementProcess("missing-pi", ["--session", "/tmp/session.jsonl"], "/tmp", () => {
			queueMicrotask(() => child.emit("error", failure));
			return child as ChildProcess;
		});
		await expect(promise).rejects.toBe(failure);
		expect(formatRecoveryCommand("missing-pi", ["--session", "/tmp/session.jsonl"])).toBe(
			"'missing-pi' '--session' '/tmp/session.jsonl'",
		);
	});

	test("returns the replacement exit status so startup failure guidance can remain bounded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-restart-child-failure-"));
		tempDirs.push(dir);
		const result = await superviseReplacementProcess(process.execPath, ["-e", "process.exit(23)"], dir);
		expect(result).toEqual({ code: 23, signal: null });
		expect(formatRecoveryCommand(process.execPath, ["--session", join(dir, "session.jsonl")])).toContain("--session");
	});

	test.skipIf(process.platform === "win32")(
		"keeps the replacement as the PTY foreground job and delays the shell prompt until it exits",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "pi-restart-pty-"));
			tempDirs.push(dir);
			const sessionFile = join(dir, "session.jsonl");
			writeFileSync(sessionFile, "session-data");
			const runner = join(dir, "restart-runner.ts");
			const helperPath = resolve(testDir, "../src/cli/restart-session.ts");
			writeFileSync(
				runner,
				`import { superviseReplacementProcess } from ${JSON.stringify(helperPath)};\n` +
					`void (async () => {\n` +
					`console.log("PARENT_START");\n` +
					`const script = "import os,sys,time; print('CHILD_TTY='+str(os.isatty(0))); print('CHILD_FG='+str(os.tcgetpgrp(0)==os.getpgrp())); print('SESSION_ARGS='+'|'.join(sys.argv[1:])); sys.stdout.flush(); time.sleep(0.2); print('CHILD_EXIT')";\n` +
					`const result = await superviseReplacementProcess("python3", ["-c", script, "--session", ${JSON.stringify(sessionFile)}, "--session-id", "session-1", "--session-leaf", "leaf-1", "--restart-session"], ${JSON.stringify(dir)});\n` +
					`console.log("PARENT_EXIT=" + result.code);\n` +
					`})();\n`,
			);
			const tsx = resolve(testDir, "../../../node_modules/.bin/tsx");
			const shellCommand = `${formatRecoveryCommand(tsx, [runner])}; printf 'SHELL_PROMPT\\n'`;
			const ptyDriver =
				"import os,pty,sys; pid,fd=pty.fork(); " +
				"(os.execvp('sh',['sh','-c',sys.argv[1]]) if pid==0 else None); out=b''; " +
				"\nwhile True:\n try: chunk=os.read(fd,4096)\n except OSError: break\n if not chunk: break\n out+=chunk\n" +
				"_,status=os.waitpid(pid,0); sys.stdout.buffer.write(out); sys.exit(os.waitstatus_to_exitcode(status))";
			const result = spawnSync("python3", ["-c", ptyDriver, shellCommand], {
				encoding: "utf8",
				timeout: 10000,
			});
			expect(result.status, result.stderr).toBe(0);
			const output = result.stdout.replaceAll("\\r", "");
			expect(output).toContain("CHILD_TTY=True");
			expect(output).toContain("CHILD_FG=True");
			expect(output).toContain(
				`SESSION_ARGS=--session|${sessionFile}|--session-id|session-1|--session-leaf|leaf-1|--restart-session`,
			);
			expect(output.indexOf("PARENT_START")).toBeLessThan(output.indexOf("CHILD_EXIT"));
			expect(output.indexOf("CHILD_EXIT")).toBeLessThan(output.indexOf("PARENT_EXIT=0"));
			expect(output.indexOf("PARENT_EXIT=0")).toBeLessThan(output.indexOf("SHELL_PROMPT"));
		},
	);

	test("renders a shell-safe recovery command", () => {
		expect(formatRecoveryCommand("node", ["pi.js", "--session", "/tmp/a'b.jsonl"])).toBe(
			"'node' 'pi.js' '--session' '/tmp/a'\\''b.jsonl'",
		);
	});
});
