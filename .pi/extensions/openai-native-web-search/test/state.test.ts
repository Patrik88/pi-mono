import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { NATIVE_WEB_SEARCH_STATE_ENTRY } from "../state.js";
import type { NativeWebSearchState } from "../types.js";
import { handleCommand, loadState } from "../index.js";

function createState(): NativeWebSearchState {
	return {
		enabled: true,
		source: "default",
	};
}

function createPi(flagValue?: boolean): ExtensionAPI {
	return {
		getFlag(name: string) {
			return name === "native-web-search" ? flagValue : undefined;
		},
	} as ExtensionAPI;
}

function createContext(enabledValues: boolean[]): ExtensionContext {
	return {
		sessionManager: {
			getEntries() {
				return enabledValues.map((enabled) => ({
					type: "custom",
					customType: NATIVE_WEB_SEARCH_STATE_ENTRY,
					data: { enabled },
				}));
			},
		},
	} as ExtensionContext;
}

function createCommandContext(): ExtensionCommandContext {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			theme: {
				fg: vi.fn((_variant: string, text: string) => text),
			},
		},
		model: {
			id: "gpt-5-mini",
			provider: "openai",
			api: "openai-responses",
		},
		getThinkingLevel: () => "low",
	} as unknown as ExtensionCommandContext;
}

describe("loadState", () => {
	it("restores persisted session state", () => {
		const state = createState();
		loadState(createPi(), createContext([false, true]), state);
		expect(state).toEqual({ enabled: true, source: "session" });
	});

	it("resets to default when the target session has no persisted state", () => {
		const state: NativeWebSearchState = { enabled: true, source: "session" };
		loadState(createPi(), createContext([]), state);
		expect(state).toEqual({ enabled: true, source: "default" });
	});

	it("reapplies the CLI flag on every load", () => {
		const state = createState();
		loadState(createPi(true), createContext([false]), state);
		expect(state).toEqual({ enabled: true, source: "flag" });
	});
});

describe("handleCommand", () => {
	it("toggles state when called without arguments", async () => {
		const state: NativeWebSearchState = { enabled: true, source: "default" };
		const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
		const ctx = createCommandContext();

		await handleCommand(pi, "", ctx, state);

		expect(state).toEqual({ enabled: false, source: "session" });
		expect(pi.appendEntry).toHaveBeenCalledWith(NATIVE_WEB_SEARCH_STATE_ENTRY, { enabled: false });
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("openai-native-web-search", undefined);
	});

	it("reports status only when explicitly asked", async () => {
		const state = createState();
		const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
		const ctx = createCommandContext();

		await handleCommand(pi, "status", ctx, state);

		expect(state).toEqual({ enabled: true, source: "default" });
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("OpenAI native web search is on for openai/gpt-5-mini.", "info");
	});
});
