import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { describeNativeWebSearchReason, evaluateNativeWebSearchPolicy, isNativeWebSearchTarget } from "./policy.js";
import { appendNativeWebSearchDirective, NATIVE_WEB_SEARCH_STATE_ENTRY } from "./state.js";
import { streamSimpleOpenAICodexResponsesWithNativeWebSearch } from "./openai-codex-provider.js";
import { streamSimpleOpenAIResponsesWithNativeWebSearch } from "./openai-provider.js";
import type { NativeWebSearchState } from "./types.js";

function buildStatus(ctx: ExtensionContext, enabled: boolean): string | undefined {
	if (!enabled) {
		return undefined;
	}

	const model = ctx.model;
	if (!model) {
		return ctx.ui.theme.fg("accent", "native-web-search:on");
	}
	if (!isNativeWebSearchTarget(model)) {
		return ctx.ui.theme.fg("muted", "native-web-search:on (inactive)");
	}

	const decision = evaluateNativeWebSearchPolicy(model, ctx.getThinkingLevel?.() ?? undefined, true);
	if (decision.enabled) {
		return ctx.ui.theme.fg("accent", "native-web-search:on");
	}
	return ctx.ui.theme.fg("warning", `native-web-search:${decision.reason}`);
}

function updateStatus(ctx: ExtensionContext, enabled: boolean): void {
	ctx.ui.setStatus("openai-native-web-search", buildStatus(ctx, enabled));
}

function describeCurrentState(ctx: ExtensionContext, enabled: boolean): string {
	if (!enabled) {
		return "OpenAI native web search is off.";
	}
	const model = ctx.model;
	if (!model) {
		return "OpenAI native web search is on.";
	}
	if (!isNativeWebSearchTarget(model)) {
		return `OpenAI native web search is on but inactive for ${model.provider}/${model.id}.`;
	}
	const decision = evaluateNativeWebSearchPolicy(model, ctx.getThinkingLevel?.() ?? undefined, true);
	if (decision.enabled) {
		return `OpenAI native web search is on for ${model.provider}/${model.id}.`;
	}
	return `OpenAI native web search is on but bypassed for ${model.provider}/${model.id}: ${describeNativeWebSearchReason(decision.reason)}.`;
}

function persistState(pi: ExtensionAPI, enabled: boolean): void {
	pi.appendEntry(NATIVE_WEB_SEARCH_STATE_ENTRY, { enabled });
}

export function loadState(pi: ExtensionAPI, ctx: ExtensionContext, state: NativeWebSearchState): void {
	const flagValue = pi.getFlag("native-web-search");
	if (flagValue === true) {
		state.enabled = true;
		state.source = "flag";
		return;
	}

	const lastStateEntry = [...ctx.sessionManager.getEntries()].reverse().find(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === NATIVE_WEB_SEARCH_STATE_ENTRY &&
			typeof (entry.data as { enabled?: unknown } | undefined)?.enabled === "boolean",
	);

	if (
		lastStateEntry &&
		lastStateEntry.type === "custom" &&
		lastStateEntry.customType === NATIVE_WEB_SEARCH_STATE_ENTRY &&
		typeof (lastStateEntry.data as { enabled?: unknown } | undefined)?.enabled === "boolean"
	) {
		state.enabled = (lastStateEntry.data as { enabled: boolean }).enabled;
		state.source = "session";
		return;
	}

	state.enabled = true;
	state.source = "default";
}

export async function handleCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	state: NativeWebSearchState,
): Promise<void> {
	const command = args.trim().toLowerCase();
	if (command === "status") {
		ctx.ui.notify(describeCurrentState(ctx, state.enabled), "info");
		return;
	}

	if (command === "" || command === "toggle") {
		state.enabled = !state.enabled;
		state.source = "session";
		persistState(pi, state.enabled);
		updateStatus(ctx, state.enabled);
		ctx.ui.notify(describeCurrentState(ctx, state.enabled), "info");
		return;
	}

	if (command === "on" || command === "enable") {
		state.enabled = true;
		state.source = "session";
		persistState(pi, true);
		updateStatus(ctx, true);
		ctx.ui.notify(describeCurrentState(ctx, true), "info");
		return;
	}

	if (command === "off" || command === "disable") {
		state.enabled = false;
		state.source = "session";
		persistState(pi, false);
		updateStatus(ctx, false);
		ctx.ui.notify("OpenAI native web search is off.", "info");
		return;
	}

	ctx.ui.notify("Usage: /native-web-search [on|off|toggle|status]", "warning");
}

export default function openaiNativeWebSearchExtension(pi: ExtensionAPI) {
	const state: NativeWebSearchState = {
		enabled: true,
		source: "default",
	};

	pi.registerFlag("native-web-search", {
		description: "Enable OpenAI native web search for supported OpenAI Responses/Codex models",
		type: "boolean",
	});

	pi.registerProvider("openai", {
		api: "openai-responses",
		streamSimple: streamSimpleOpenAIResponsesWithNativeWebSearch,
	});

	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple: streamSimpleOpenAICodexResponsesWithNativeWebSearch,
	});

	pi.registerCommand("native-web-search", {
		description: "Enable or disable OpenAI native web search for this session",
		handler: async (args, ctx) => {
			await handleCommand(pi, args, ctx, state);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		loadState(pi, ctx, state);
		updateStatus(ctx, state.enabled);
	});

	pi.on("session_switch", async (_event, ctx) => {
		loadState(pi, ctx, state);
		updateStatus(ctx, state.enabled);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx, state.enabled);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.enabled || !isNativeWebSearchTarget(ctx.model)) {
			return;
		}
		return {
			systemPrompt: appendNativeWebSearchDirective(event.systemPrompt),
		};
	});
}
