import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { NATIVE_WEB_SEARCH_STATE_ENTRY } from "../state.js";
import type { NativeWebSearchState } from "../types.js";
import { loadState } from "../index.js";

function createState(): NativeWebSearchState {
	return {
		enabled: false,
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

describe("loadState", () => {
	it("restores persisted session state", () => {
		const state = createState();
		loadState(createPi(), createContext([false, true]), state);
		expect(state).toEqual({ enabled: true, source: "session" });
	});

	it("resets to default when the target session has no persisted state", () => {
		const state: NativeWebSearchState = { enabled: true, source: "session" };
		loadState(createPi(), createContext([]), state);
		expect(state).toEqual({ enabled: false, source: "default" });
	});

	it("reapplies the CLI flag on every load", () => {
		const state = createState();
		loadState(createPi(true), createContext([false]), state);
		expect(state).toEqual({ enabled: true, source: "flag" });
	});
});
