import { describe, expect, it } from "vitest";
import {
	type BranchSummaryEntry,
	buildSessionContext,
	type CompactionEntry,
	type CustomMessageEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") {
		return { ...base, message: { role, content: text, timestamp: 1 } };
	}
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function customMessage(id: string, parentId: string | null, content: string): CustomMessageEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		customType: "test-custom",
		content,
		display: true,
	};
}

function branchSummary(id: string, parentId: string | null, summary: string, fromId: string): BranchSummaryEntry {
	return { type: "branch_summary", id, parentId, timestamp: "2025-01-01T00:00:00Z", summary, fromId };
}

function compaction(id: string, parentId: string | null, summary: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1000,
	};
}

describe("session context items", () => {
	it("maps normal, custom, and branch-summary messages in lockstep", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "hello"),
			customMessage("2", "1", "runtime context"),
			branchSummary("3", "2", "branch summary", "1"),
		];

		const ctx = buildSessionContext(entries);

		expect(ctx.messages).toHaveLength(3);
		expect(ctx.items).toHaveLength(3);
		expect(ctx.items?.map((item) => item.entryId)).toEqual(["1", "2", "3"]);
		expect(ctx.items?.map((item) => item.kind)).toEqual(["message", "custom_message", "branch_summary"]);
		expect(ctx.items?.map((item) => item.source.phase)).toEqual(["normal", "normal", "normal"]);
		expect(ctx.items?.map((item) => item.message)).toEqual(ctx.messages);
	});

	it("maps compaction summary, kept messages, and post-compaction messages", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first"),
			msg("2", "1", "assistant", "response1"),
			msg("3", "2", "user", "second"),
			compaction("4", "3", "summary", "2"),
			msg("5", "4", "user", "third"),
		];

		const ctx = buildSessionContext(entries);

		expect(ctx.messages).toHaveLength(4);
		expect(ctx.items?.map((item) => item.entryId)).toEqual(["4", "2", "3", "5"]);
		expect(ctx.items?.map((item) => item.kind)).toEqual(["compaction_summary", "message", "message", "message"]);
		expect(ctx.items?.map((item) => item.source.phase)).toEqual([
			"compaction-summary",
			"post-compaction-kept",
			"post-compaction-kept",
			"post-compaction-after",
		]);
		expect(ctx.items?.[0].source.compactionEntryId).toBe("4");
		expect(ctx.items?.[1].source).toMatchObject({ compactionEntryId: "4", originalEntryId: "2" });
		expect(ctx.items?.map((item) => item.message)).toEqual(ctx.messages);
	});
});
