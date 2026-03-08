import type { Api, Model, ThinkingLevel } from "../../../packages/ai/src/types.js";
import type { NativeWebSearchDecision, NativeWebSearchDisableReason } from "./types.js";

export type NativeWebSearchModel = Pick<Model<Api>, "api" | "provider" | "id">;

const UNSUPPORTED_OPENAI_RESPONSES_MODELS = new Set(["gpt-4.1-nano"]);

export function isGpt5Family(modelId: string): boolean {
	return modelId === "gpt-5" || modelId.startsWith("gpt-5-") || modelId.startsWith("gpt-5.");
}

export function isNativeWebSearchTarget(model: NativeWebSearchModel | undefined): boolean {
	if (!model) return false;
	if (model.api === "openai-codex-responses") {
		return model.provider === "openai-codex";
	}
	if (model.api === "openai-responses") {
		return model.provider === "openai";
	}
	return false;
}

export function supportsNativeWebSearchModel(model: NativeWebSearchModel | undefined): boolean {
	if (!model) return false;
	if (!isNativeWebSearchTarget(model)) return false;
	if (model.provider === "openai") {
		return !UNSUPPORTED_OPENAI_RESPONSES_MODELS.has(model.id);
	}
	return true;
}

export function evaluateNativeWebSearchPolicy(
	model: NativeWebSearchModel | undefined,
	reasoning: ThinkingLevel | undefined,
	optedIn: boolean,
): NativeWebSearchDecision {
	if (!optedIn) {
		return { enabled: false, reason: "not_opted_in" };
	}
	if (!model || !isNativeWebSearchTarget(model)) {
		return { enabled: false, reason: "unsupported_provider" };
	}
	if (!supportsNativeWebSearchModel(model)) {
		return { enabled: false, reason: "unsupported_model" };
	}
	if (isGpt5Family(model.id) && reasoning === "minimal") {
		return { enabled: false, reason: "gpt5_minimal_reasoning" };
	}
	return { enabled: true };
}

export function describeNativeWebSearchReason(reason: NativeWebSearchDisableReason | undefined): string {
	switch (reason) {
		case "not_opted_in":
			return "not opted in";
		case "unsupported_provider":
			return "inactive for the current provider/model";
		case "unsupported_model":
			return "unsupported model";
		case "gpt5_minimal_reasoning":
			return "disabled for GPT-5 with minimal reasoning";
		default:
			return "enabled";
	}
}
