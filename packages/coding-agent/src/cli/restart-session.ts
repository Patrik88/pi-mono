import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";

const DROP_FLAGS = new Set([
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--no-session",
	"--print",
	"-p",
	"--help",
	"-h",
	"--version",
	"-v",
	"--list-models",
	"--restart-session",
]);
const DROP_VALUE_FLAGS = new Set([
	"--session",
	"--session-id",
	"--session-leaf",
	"--fork",
	"--export",
	"--mode",
	"--name",
	"-n",
]);
const PRESERVE_VALUE_FLAGS = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--thinking",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
]);
const PRESERVE_BOOLEAN_FLAGS = new Set([
	"--no-tools",
	"-nt",
	"--no-builtin-tools",
	"-nbt",
	"--no-extensions",
	"-ne",
	"--no-skills",
	"-ns",
	"--no-prompt-templates",
	"-np",
	"--no-themes",
	"--no-context-files",
	"-nc",
	"--verbose",
	"--approve",
	"-a",
	"--no-approve",
	"-na",
	"--offline",
]);

export function buildRestartArguments(
	originalArgs: readonly string[],
	sessionFile: string,
	leafId: string | null,
): string[] {
	const result: string[] = [];
	for (let index = 0; index < originalArgs.length; index += 1) {
		const arg = originalArgs[index];
		if (DROP_FLAGS.has(arg)) continue;
		if (DROP_VALUE_FLAGS.has(arg)) {
			index += 1;
			continue;
		}
		if (PRESERVE_BOOLEAN_FLAGS.has(arg)) {
			result.push(arg);
			continue;
		}
		if (PRESERVE_VALUE_FLAGS.has(arg)) {
			const value = originalArgs[index + 1];
			if (value !== undefined) {
				result.push(arg, value);
				index += 1;
			}
			continue;
		}
		if (arg.startsWith("--") && arg.includes("=")) {
			result.push(arg);
			continue;
		}
		if (arg.startsWith("--")) {
			result.push(arg);
			const value = originalArgs[index + 1];
			if (value !== undefined && !value.startsWith("-") && !value.startsWith("@")) {
				result.push(value);
				index += 1;
			}
		}
	}
	result.push("--session", resolve(sessionFile));
	if (leafId !== null) result.push("--session-leaf", leafId);
	result.push("--restart-session");
	return result;
}

export function preflightRestart(sessionFile: string, cwd: string): void {
	accessSync(resolve(sessionFile), constants.R_OK);
	accessSync(resolve(cwd), constants.R_OK);
}

export function formatRecoveryCommand(command: string, args: readonly string[]): string {
	const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
	return [command, ...args].map(quote).join(" ");
}
