import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { RestartSessionStatus } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

const tempDirs: string[] = [];
const testDir = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function extensionSource(marker: string, probeFile: string): string {
	return `import { appendFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const probeFile = ${JSON.stringify(probeFile)};
function record(kind, ctx, reason) {
 appendFileSync(probeFile, JSON.stringify({ kind, pid: process.pid, reason, marker, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), leafId: ctx.sessionManager.getLeafId(), branchIds: ctx.sessionManager.getBranch().map((entry) => entry.id), branchText: ctx.sessionManager.getBranch().map((entry) => entry.type === "message" && entry.message.role === "user" ? entry.message.content : null) }) + "\\n");
 if (kind === "session_start") console.log("HOST_START:" + marker);
}
export default function (pi) {
 pi.on("session_start", async (event, ctx) => record("session_start", ctx, event.reason));
 pi.on("session_shutdown", async (event, ctx) => record("session_shutdown", ctx, event.reason));
 pi.registerCommand("restart-probe", { handler: async (_args, ctx) => { await ctx.restartSession(); } });
}
`;
}

type RestartStatusContext = {
	sessionManager: { isPersisted: () => boolean; getSessionFile: () => string | undefined };
	session: {
		isIdle: boolean;
		isCompacting: boolean;
		isRetrying: boolean;
		retryAttempt: number;
		pendingMessageCount: number;
		getPauseStatus: () => { state: string };
	};
	compactionQueuedMessages: unknown[];
	bashComponent?: unknown;
	pendingBashComponents: unknown[];
	isShuttingDown: boolean;
};

type InteractiveModePrivate = {
	getRestartSessionStatus(this: RestartStatusContext): RestartSessionStatus;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function restartStatus(overrides: Partial<RestartStatusContext> = {}): RestartSessionStatus {
	const context: RestartStatusContext = {
		sessionManager: { isPersisted: () => true, getSessionFile: () => "/tmp/session.jsonl" },
		session: {
			isIdle: true,
			isCompacting: false,
			isRetrying: false,
			retryAttempt: 0,
			pendingMessageCount: 0,
			getPauseStatus: () => ({ state: "none" }),
		},
		compactionQueuedMessages: [],
		pendingBashComponents: [],
		isShuttingDown: false,
		...overrides,
	};
	return interactiveModePrototype.getRestartSessionStatus.call(context);
}

describe("exact-session restart full host", () => {
	test.skipIf(process.platform === "win32")(
		"restarts the actual CLI/TUI on the exact non-tip leaf with fresh extension source and foreground ownership",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "pi-restart-full-host-"));
			tempDirs.push(dir);
			const probeFile = join(dir, "probe.jsonl");
			const extensionFile = join(dir, "restart-probe.ts");
			const manager = SessionManager.create(dir, dir, { id: "restart-full-host" });
			manager.appendMessage({ role: "user", content: "selected branch", timestamp: Date.now() });
			const selectedLeaf = manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "selected response" }],
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
			manager.appendMessage({ role: "user", content: "unselected tip", timestamp: Date.now() });
			manager.branch(selectedLeaf);
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();

			writeFileSync(extensionFile, extensionSource("v1", probeFile));
			const wrapper = join(dir, "pi-wrapper.mjs");
			const cli = resolve(testDir, "../../../src/cli.ts");
			const tsxLoader = import.meta.resolve("tsx/esm");
			writeFileSync(wrapper, `import ${JSON.stringify(tsxLoader)}; await import(${JSON.stringify(cli)});\n`);

			const driver = `
import base64, json, os, pty, select, sys, time
command, extension_file, replacement = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
 os.execvp("sh", ["sh", "-c", command])
out = b""
sent_restart = False
sent_quit = False
deadline = time.time() + 20
while time.time() < deadline:
 readable, _, _ = select.select([fd], [], [], 0.1)
 if readable:
  try: chunk = os.read(fd, 4096)
  except OSError: break
  if not chunk: break
  out += chunk
 text = out.decode("utf-8", "replace")
 if not sent_restart and "HOST_START:v1" in text:
  open(extension_file, "wb").write(base64.b64decode(replacement))
  os.write(fd, b"/restart-probe\\r")
  sent_restart = True
 if sent_restart and not sent_quit and "HOST_START:v2" in text:
  os.write(fd, b"\\x04")
  sent_quit = True
if time.time() >= deadline:
 os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
`;
			const command = `${[
				JSON.stringify(process.execPath),
				JSON.stringify(wrapper),
				"--session",
				JSON.stringify(sessionFile),
				"--session-dir",
				JSON.stringify(dir),
				"--session-leaf",
				JSON.stringify(selectedLeaf),
				"--extension",
				JSON.stringify(extensionFile),
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
			].join(" ")}; status=$?; printf 'SHELL_CONTROL\\n'; exit $status`;
			const replacement = Buffer.from(extensionSource("v2", probeFile)).toString("base64");
			const result = spawnSync("python3", ["-c", driver, command, extensionFile, replacement], {
				encoding: "utf8",
				timeout: 25000,
				env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			});
			expect(result.status, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`).toBe(0);

			const records = readFileSync(probeFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(records.map(({ kind, reason, marker }) => [kind, reason, marker])).toEqual([
				["session_start", "startup", "v1"],
				["session_shutdown", "restart", "v1"],
				["session_start", "restart", "v2"],
				["session_shutdown", "quit", "v2"],
			]);
			expect(new Set(records.map((record) => record.pid)).size).toBe(2);
			const expectedRestartLeaf = records[0].leafId;
			expect(expectedRestartLeaf).not.toBe(manager.getEntries().at(-1)?.id);
			for (const record of records) {
				expect(record.sessionId).toBe("restart-full-host");
				expect(record.sessionFile).toBe(sessionFile);
				expect(record.leafId).toBe(expectedRestartLeaf);
				expect(record.branchIds.at(-1)).toBe(expectedRestartLeaf);
				expect(record.branchText).toContain("selected branch");
				expect(record.branchText).not.toContain("unselected tip");
			}
			const output = result.stdout.replaceAll("\r", "");
			expect(output.indexOf("HOST_START:v2")).toBeLessThan(output.indexOf("SHELL_CONTROL"));
		},
	);
});

describe("exact-session restart host status", () => {
	test.each([
		["queued", { session: { ...restartStatusContext().session, pendingMessageCount: 1 } }, "messages are queued"],
		[
			"paused",
			{ session: { ...restartStatusContext().session, getPauseStatus: () => ({ state: "paused" }) } },
			"paused continuation",
		],
		["compacting", { session: { ...restartStatusContext().session, isCompacting: true } }, "compaction"],
		["retrying", { session: { ...restartStatusContext().session, isRetrying: true } }, "automatic retry"],
		["terminal", { bashComponent: {} }, "transient terminal work"],
	] as const)("classifies %s state as blocked", (_name, overrides, reason) => {
		expect(restartStatus(overrides)).toEqual({
			supported: true,
			state: "blocked",
			reason: expect.stringContaining(reason),
		});
	});
});

function restartStatusContext(): RestartStatusContext {
	return {
		sessionManager: { isPersisted: () => true, getSessionFile: () => "/tmp/session.jsonl" },
		session: {
			isIdle: true,
			isCompacting: false,
			isRetrying: false,
			retryAttempt: 0,
			pendingMessageCount: 0,
			getPauseStatus: () => ({ state: "none" }),
		},
		compactionQueuedMessages: [],
		pendingBashComponents: [],
		isShuttingDown: false,
	};
}
