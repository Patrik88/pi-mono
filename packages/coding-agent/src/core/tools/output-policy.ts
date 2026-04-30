import type { Model } from "@mariozechner/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationOptions } from "./truncate.js";

export type ToolOutputPolicyPurpose = "model-context" | "display" | "compaction" | "bash-execution";
export type ToolOutputPolicyStrategy = "head" | "tail";

export interface ToolOutputPolicy {
	maxBytes: number;
	maxLines: number;
	strategy: ToolOutputPolicyStrategy;
	saveFullOutput: boolean;
}

export interface ToolOutputPolicyRequest<TInput = unknown> {
	toolName: string;
	toolCallId?: string;
	input?: TInput;
	cwd: string;
	purpose: ToolOutputPolicyPurpose;
	model?: Model<any>;
}

export type ToolOutputPolicyProvider = (
	request: ToolOutputPolicyRequest,
	current: ToolOutputPolicy,
) => ToolOutputPolicy | Partial<ToolOutputPolicy> | undefined;

export const DEFAULT_TOOL_OUTPUT_POLICY: ToolOutputPolicy = {
	maxBytes: DEFAULT_MAX_BYTES,
	maxLines: DEFAULT_MAX_LINES,
	strategy: "head",
	saveFullOutput: true,
};

export const TOOL_OUTPUT_POLICY_HARD_MAX_BYTES = 1024 * 1024;
export const TOOL_OUTPUT_POLICY_HARD_MAX_LINES = 50_000;

export function defaultToolOutputPolicy(strategy: ToolOutputPolicyStrategy = "head"): ToolOutputPolicy {
	return { ...DEFAULT_TOOL_OUTPUT_POLICY, strategy };
}

export function normalizeToolOutputPolicy(policy: Partial<ToolOutputPolicy>): ToolOutputPolicy {
	const fallback = DEFAULT_TOOL_OUTPUT_POLICY;
	return {
		maxBytes: clampPositiveInteger(policy.maxBytes, fallback.maxBytes, TOOL_OUTPUT_POLICY_HARD_MAX_BYTES),
		maxLines: clampPositiveInteger(policy.maxLines, fallback.maxLines, TOOL_OUTPUT_POLICY_HARD_MAX_LINES),
		strategy: policy.strategy === "tail" ? "tail" : "head",
		saveFullOutput: policy.saveFullOutput !== false,
	};
}

export function resolveToolOutputPolicy(
	providers: readonly ToolOutputPolicyProvider[],
	request: ToolOutputPolicyRequest,
	initial: Partial<ToolOutputPolicy> = {},
): ToolOutputPolicy {
	let current = normalizeToolOutputPolicy({ ...DEFAULT_TOOL_OUTPUT_POLICY, ...initial });
	for (const provider of providers) {
		const next = provider(request, current);
		if (!next) continue;
		current = normalizeToolOutputPolicy({ ...current, ...next });
	}
	return current;
}

export function truncationOptionsFromPolicy(policy: ToolOutputPolicy): TruncationOptions {
	return { maxBytes: policy.maxBytes, maxLines: policy.maxLines };
}

function clampPositiveInteger(value: unknown, fallback: number, hardMax: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(Math.max(1, Math.floor(value)), hardMax);
}
