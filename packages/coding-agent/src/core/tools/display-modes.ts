export type ToolCallDisplayMode = "minimal" | "full";
export type ToolResultDisplayMode = "minimal" | "compact" | "full";

export function normalizeToolCallDisplayMode(value: unknown): ToolCallDisplayMode {
	return value === "full" ? "full" : "minimal";
}

export function normalizeToolResultDisplayMode(value: unknown): ToolResultDisplayMode {
	return value === "compact" || value === "full" ? value : "minimal";
}
