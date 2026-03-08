import type { Context } from "../../../packages/ai/src/types.js";

export const NATIVE_WEB_SEARCH_DIRECTIVE = "<!-- pi:openai-native-web-search:enabled -->";
export const NATIVE_WEB_SEARCH_STATE_ENTRY = "openai-native-web-search-state";

export interface DirectiveExtractionResult {
	context: Context;
	optedIn: boolean;
}

export function appendNativeWebSearchDirective(systemPrompt: string | undefined): string {
	if (!systemPrompt) {
		return NATIVE_WEB_SEARCH_DIRECTIVE;
	}
	if (systemPrompt.includes(NATIVE_WEB_SEARCH_DIRECTIVE)) {
		return systemPrompt;
	}
	return `${systemPrompt}\n${NATIVE_WEB_SEARCH_DIRECTIVE}`;
}

export function stripNativeWebSearchDirective(systemPrompt: string | undefined): {
	systemPrompt: string | undefined;
	optedIn: boolean;
} {
	if (!systemPrompt || !systemPrompt.includes(NATIVE_WEB_SEARCH_DIRECTIVE)) {
		return { systemPrompt, optedIn: false };
	}

	const cleaned = systemPrompt
		.split("\n")
		.filter((line) => line.trim() !== NATIVE_WEB_SEARCH_DIRECTIVE)
		.join("\n")
		.trimEnd();

	return {
		systemPrompt: cleaned.length > 0 ? cleaned : undefined,
		optedIn: true,
	};
}

export function extractDirectiveContext(context: Context): DirectiveExtractionResult {
	const { systemPrompt, optedIn } = stripNativeWebSearchDirective(context.systemPrompt);
	return {
		context: {
			...context,
			systemPrompt,
		},
		optedIn,
	};
}
