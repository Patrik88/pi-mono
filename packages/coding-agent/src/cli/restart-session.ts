import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionFlag } from "../core/extensions/types.ts";

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
	sessionId: string,
	leafId: string | null,
	extensionFlags: readonly ExtensionFlag[] = [],
): string[] {
	const result: string[] = [];
	const registeredFlags = new Map(extensionFlags.map((flag) => [`--${flag.name}`, flag.type]));
	for (let index = 0; index < originalArgs.length; index += 1) {
		const arg = originalArgs[index];
		const equalsIndex = arg.indexOf("=");
		const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
		if (DROP_FLAGS.has(flag)) continue;
		if (DROP_VALUE_FLAGS.has(flag)) {
			if (equalsIndex === -1) index += 1;
			continue;
		}
		if (PRESERVE_BOOLEAN_FLAGS.has(flag)) {
			result.push(arg);
			continue;
		}
		if (PRESERVE_VALUE_FLAGS.has(flag)) {
			if (equalsIndex !== -1) {
				result.push(arg);
				continue;
			}
			const value = originalArgs[index + 1];
			if (value !== undefined) {
				result.push(arg, value);
				index += 1;
			}
			continue;
		}
		const extensionFlagType = registeredFlags.get(flag);
		if (extensionFlagType === undefined) continue;
		if (equalsIndex !== -1 || extensionFlagType === "boolean") {
			result.push(arg);
			continue;
		}
		const value = originalArgs[index + 1];
		if (value !== undefined && !value.startsWith("@")) {
			result.push(arg, value);
			index += 1;
		}
	}
	result.push("--session", resolve(sessionFile), "--session-id", sessionId);
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
