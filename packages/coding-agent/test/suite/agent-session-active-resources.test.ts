import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession active resources", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	async function createResourceHarness(extensionInputs: CreateTestExtensionsResultInput[] = []) {
		const tempDir = join(tmpdir(), `pi-active-resources-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);

		const skillPath = join(tempDir, "test-skill.md");
		writeFileSync(skillPath, "---\ndescription: Test skill\n---\n# Test Skill\n\nUse the active skill body.");
		const skill: Skill = {
			name: "test",
			description: "Test skill",
			filePath: skillPath,
			baseDir: tempDir,
			disableModelInvocation: false,
			sourceInfo: createSyntheticSourceInfo(skillPath, {
				source: "local",
				scope: "project",
				origin: "top-level",
				baseDir: tempDir,
			}),
		};

		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this: $1",
			filePath: join(tempDir, "review.md"),
			sourceInfo: createSyntheticSourceInfo(join(tempDir, "review.md"), {
				source: "local",
				scope: "project",
				origin: "top-level",
				baseDir: tempDir,
			}),
		};

		const extensionsResult = await createTestExtensionsResult(extensionInputs, tempDir);
		const baseResourceLoader = createTestResourceLoader({ extensionsResult });
		const resourceLoader = {
			...baseResourceLoader,
			getSkills: () => ({ skills: [skill], diagnostics: [] }),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};

		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		return harness;
	}

	it("omits inactive skills from the system prompt and blocks /skill expansion locally", async () => {
		const harness = await createResourceHarness();

		expect(harness.session.systemPrompt).toContain("Test skill");
		expect(harness.session.getAllSkills().map((skill) => skill.name)).toEqual(["test"]);
		expect(harness.session.getActiveSkills().map((skill) => skill.name)).toEqual(["test"]);

		harness.session.setActiveSkills([]);

		expect(harness.session.systemPrompt).not.toContain("Test skill");
		expect(harness.session.getAllSkills().map((skill) => skill.name)).toEqual(["test"]);
		expect(harness.session.getActiveSkills()).toEqual([]);
		await expect(harness.session.prompt("/skill:test explain this")).rejects.toThrow(
			'Skill command "/skill:test" is inactive.',
		);

		harness.session.setActiveSkills(["test"]);
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				return fauxAssistantMessage(getMessageText(user));
			},
		]);

		await harness.session.prompt("/skill:test explain this");

		expect(getMessageText(harness.session.messages[0])).toContain('<skill name="test" location="');
		expect(getMessageText(harness.session.messages[0])).toContain("Use the active skill body.");
	});

	it("blocks inactive prompt templates and expands them again when reactivated", async () => {
		const harness = await createResourceHarness();

		expect(harness.session.getAllCommands().map((command) => `${command.source}:${command.name}`)).toContain(
			"prompt:review",
		);
		expect(harness.session.getActiveCommands().map((command) => `${command.source}:${command.name}`)).toContain(
			"prompt:review",
		);

		harness.session.setActiveCommands({ prompt: [] });

		expect(harness.session.getAllPromptTemplates().map((template) => template.name)).toEqual(["review"]);
		expect(harness.session.getActivePromptTemplates()).toEqual([]);
		await expect(harness.session.prompt("/review src/index.ts")).rejects.toThrow(
			'Prompt command "/review" is inactive.',
		);

		harness.session.setActiveCommands({ prompt: ["review"] });
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				return fauxAssistantMessage(getMessageText(user));
			},
		]);

		await harness.session.prompt("/review src/index.ts");

		expect(getMessageText(harness.session.messages[0])).toBe("Review this: src/index.ts");
	});

	it("blocks inactive extension commands without falling through to the provider", async () => {
		const commandRuns: string[] = [];
		const harness = await createResourceHarness([
			{
				factory: (pi) => {
					pi.registerCommand("blocked", {
						description: "Blocked command",
						handler: async () => {
							commandRuns.push("blocked");
						},
					});
					pi.registerCommand("inspect", {
						description: "Inspect command",
						handler: async () => {
							commandRuns.push("inspect");
						},
					});
				},
			},
		]);
		harness.setResponses([fauxAssistantMessage("should not be used")]);
		harness.session.setActiveCommands({ extension: ["inspect"] });

		await expect(harness.session.prompt("/blocked now")).rejects.toThrow('Extension command "/blocked" is inactive.');

		expect(commandRuns).toEqual([]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		await harness.session.prompt("/inspect");

		expect(commandRuns).toEqual(["inspect"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("ExtensionAPI reports loaded versus active skills and commands separately", async () => {
		type Snapshot = {
			allCommands: string[];
			activeCommands: string[];
			commands: string[];
			allSkills: string[];
			activeSkills: string[];
		};
		const snapshots: Snapshot[] = [];
		const harness = await createResourceHarness([
			{
				factory: (pi) => {
					pi.registerCommand("blocked", {
						description: "Blocked command",
						handler: async () => {},
					});
					pi.registerCommand("inspect", {
						description: "Inspect command",
						handler: async () => {
							snapshots.push({
								allCommands: pi
									.getAllCommands()
									.map((command) => `${command.source}:${command.name}`)
									.sort(),
								activeCommands: pi
									.getActiveCommands()
									.map((command) => `${command.source}:${command.name}`)
									.sort(),
								commands: pi
									.getCommands()
									.map((command) => `${command.source}:${command.name}`)
									.sort(),
								allSkills: pi.getAllSkills().map((skill) => skill.name),
								activeSkills: pi.getActiveSkills().map((skill) => skill.name),
							});
						},
					});
				},
			},
		]);

		harness.session.setActiveSkills(["test"]);
		harness.session.setActiveCommands({ prompt: ["review"], extension: ["inspect"] });

		await harness.session.prompt("/inspect");

		expect(snapshots).toEqual([
			{
				allCommands: ["extension:blocked", "extension:inspect", "prompt:review", "skill:skill:test"],
				activeCommands: ["extension:inspect", "prompt:review", "skill:skill:test"],
				commands: ["extension:blocked", "extension:inspect", "prompt:review", "skill:skill:test"],
				allSkills: ["test"],
				activeSkills: ["test"],
			},
		]);
	});
});
