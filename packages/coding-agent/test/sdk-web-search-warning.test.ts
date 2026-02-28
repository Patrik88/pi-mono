import { getModel } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createTestResourceLoader } from "./utilities.js";

describe("createAgentSession native web search startup warnings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns a warning for gpt-5 with minimal thinking and native web search enabled", async () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const model = getModel("openai", "gpt-5");
		expect(model).toBeDefined();

		const { startupWarnings } = await createAgentSession({
			model,
			thinkingLevel: "minimal",
			enableNativeWebSearch: true,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});

		expect(startupWarnings).toHaveLength(1);
		expect(startupWarnings?.[0]).toContain("bypasses web search");
		expect(consoleWarn).not.toHaveBeenCalled();
	});

	it("does not return a warning for gpt-5 with low thinking", async () => {
		const model = getModel("openai", "gpt-5");
		expect(model).toBeDefined();

		const { startupWarnings } = await createAgentSession({
			model,
			thinkingLevel: "low",
			enableNativeWebSearch: true,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});

		expect(startupWarnings).toBeUndefined();
	});

	it("does not return a warning when native web search is disabled", async () => {
		const model = getModel("openai", "gpt-5");
		expect(model).toBeDefined();

		const { startupWarnings } = await createAgentSession({
			model,
			thinkingLevel: "minimal",
			enableNativeWebSearch: false,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});

		expect(startupWarnings).toBeUndefined();
	});

	it("does not return a warning for non-gpt-5 models", async () => {
		const model = getModel("openai", "gpt-4.1");
		expect(model).toBeDefined();

		const { startupWarnings } = await createAgentSession({
			model,
			thinkingLevel: "minimal",
			enableNativeWebSearch: true,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});

		expect(startupWarnings).toBeUndefined();
	});
});
