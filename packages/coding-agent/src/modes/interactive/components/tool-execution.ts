import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
	ToolCallDisplayMode,
	ToolDefinition,
	ToolRenderContext,
	ToolResultDisplayMode,
} from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	callDisplayMode?: ToolCallDisplayMode;
	resultDisplayMode?: ToolResultDisplayMode;
}

const INLINE_VALUE_LIMIT = 120;

function compactJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

function truncateInlineValue(value: string): string {
	if (value.length <= INLINE_VALUE_LIMIT) return value;
	return `${value.slice(0, INLINE_VALUE_LIMIT - 1)}…`;
}

function formatInlineValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value === "boolean" || typeof value === "number") return String(value);
	if (typeof value === "bigint") return `${String(value)}n`;
	if (typeof value === "string") return truncateInlineValue(JSON.stringify(value));

	const json = compactJson(value);
	if (json && json.length <= INLINE_VALUE_LIMIT && !json.includes("\n")) return json;
	if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
	if (typeof value === "object") {
		let count = 0;
		try {
			count = Object.keys(value).length;
		} catch {
			return "{…}";
		}
		return `{${count} key${count === 1 ? "" : "s"}}`;
	}
	return truncateInlineValue(String(value));
}

export function formatMinimalToolCall(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return `${toolName}(value=${formatInlineValue(args)})`;
	}

	let entries: Array<[string, unknown]>;
	try {
		entries = Object.entries(args as Record<string, unknown>);
	} catch {
		return `${toolName}({…})`;
	}
	return `${toolName}(${entries.map(([key, value]) => `${key}=${formatInlineValue(value)}`).join(", ")})`;
}

function formatFullToolCall(toolName: string, args: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(args, null, 2) ?? String(args);
	} catch {
		serialized = String(args);
	}
	return `${toolName}\n${serialized}`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private callDisplayMode: ToolCallDisplayMode;
	private resultDisplayMode: ToolResultDisplayMode;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.callDisplayMode = options.callDisplayMode ?? "minimal";
		this.resultDisplayMode = options.resultDisplayMode ?? "compact";
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) return this.toolDefinition?.renderCall;
		if (!this.toolDefinition) return this.builtInToolDefinition.renderCall;
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) return this.toolDefinition?.renderResult;
		if (!this.toolDefinition) return this.builtInToolDefinition.renderResult;
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) return this.toolDefinition?.renderShell ?? "default";
		if (!this.toolDefinition) return this.builtInToolDefinition.renderShell ?? "default";
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.resultDisplayMode === "full",
			callDisplayMode: this.callDisplayMode,
			resultDisplayMode: this.resultDisplayMode,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallComponent(): Component {
		const text =
			this.callDisplayMode === "full"
				? formatFullToolCall(this.toolName, this.args)
				: formatMinimalToolCall(this.toolName, this.args);
		return new Text(theme.fg("toolTitle", text), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		return output ? new Text(theme.fg("toolOutput", output), 0, 0) : undefined;
	}

	private refreshCallRenderer(): void {
		const callRenderer = this.getCallRenderer();
		if (!callRenderer) {
			this.callRendererComponent = undefined;
			return;
		}
		try {
			this.callRendererComponent = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
		} catch {
			this.callRendererComponent = undefined;
		}
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		if (this.resultDisplayMode === "minimal") return;
		const caps = getCapabilities();
		if (caps.images !== "kitty" || !this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType || img.mimeType === "image/png" || this.convertedImages.has(i)) continue;
			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setDisplayModes(callMode: ToolCallDisplayMode, resultMode: ToolResultDisplayMode): void {
		this.callDisplayMode = callMode;
		this.resultDisplayMode = resultMode;
		this.updateDisplay();
	}

	setCallDisplayMode(mode: ToolCallDisplayMode): void {
		this.callDisplayMode = mode;
		this.updateDisplay();
	}

	setResultDisplayMode(mode: ToolResultDisplayMode): void {
		this.resultDisplayMode = mode;
		this.updateDisplay();
	}

	/** Compatibility API: false retains the former compact renderer, true selects full. */
	setExpanded(expanded: boolean): void {
		this.setResultDisplayMode(expanded ? "full" : "compact");
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) return [];
		if (this.resultDisplayMode === "minimal") return this.renderMinimal(width);

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) return [];
			const lines: string[] = [];
			if (contentLines.length > 0) lines.push("", ...contentLines);
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) lines.push(...spacer.render(width));
				const imageComponent = this.imageComponents[i];
				if (imageComponent) lines.push(...imageComponent.render(width));
			}
			return lines;
		}

		return super.render(width);
	}

	private renderMinimal(width: number): string[] {
		const status = this.formatMinimalResultStatus();
		if (this.callDisplayMode === "full") {
			const callLines = formatFullToolCall(this.toolName, this.args)
				.split("\n")
				.flatMap((line) => wrapTextWithAnsi(theme.fg("toolTitle", line), width));
			if (this.callRendererComponent) {
				callLines.push(
					...this.callRendererComponent.render(width).map((line) => truncateToWidth(line, width, "…")),
				);
			}
			if (status) callLines.push(truncateToWidth(status, width, "…"));
			return callLines;
		}

		const call = theme.fg("toolTitle", formatMinimalToolCall(this.toolName, this.args));
		if (!status) return [truncateToWidth(call, width, "…")];
		const separator = "  ";
		const maxStatusWidth = Math.max(8, Math.floor(width * 0.4));
		const boundedStatus = truncateToWidth(status, maxStatusWidth, "…");
		const availableCallWidth = Math.max(1, width - visibleWidth(boundedStatus) - separator.length);
		const callText = truncateToWidth(call, availableCallWidth, "…");
		return [truncateToWidth(`${callText}${separator}${boundedStatus}`, width, "…")];
	}

	private formatMinimalResultStatus(): string {
		if (!this.result || this.isPartial) {
			return theme.fg("muted", "…");
		}
		const textBlocks = this.result.content.filter((block) => block.type === "text" && typeof block.text === "string");
		const text = textBlocks.map((block) => block.text ?? "").join("\n");
		if (this.result.isError) {
			const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
			return theme.fg("error", firstLine ? `✗ ${firstLine}` : "✗ error");
		}

		const details: string[] = [];
		if (text) {
			const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
			const lineCount = normalized ? normalized.split("\n").length : 0;
			if (lineCount > 0) details.push(`${lineCount} line${lineCount === 1 ? "" : "s"}`);
			details.push(formatBytes(Buffer.byteLength(text)));
		}
		const imageCount = this.result.content.filter((block) => block.type === "image").length;
		if (imageCount > 0) details.push(`${imageCount} image${imageCount === 1 ? "" : "s"}`);
		return theme.fg("success", details.length > 0 ? `✓ ${details.join(" · ")}` : "✓");
	}

	private updateDisplay(): void {
		this.hideComponent = false;
		if (this.callDisplayMode === "full" || this.resultDisplayMode !== "minimal") this.refreshCallRenderer();
		if (this.resultDisplayMode === "minimal") {
			this.clearImages();
			return;
		}

		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) renderContainer.setBgFn(bgFn);
			renderContainer.clear();
			renderContainer.addChild(this.createCallComponent());
			if (this.callDisplayMode === "full" && this.callRendererComponent) {
				renderContainer.addChild(this.callRendererComponent);
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) renderContainer.addChild(component);
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{
								expanded: this.resultDisplayMode === "full",
								displayMode: this.resultDisplayMode,
								isPartial: this.isPartial,
							},
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) renderContainer.addChild(component);
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatFallbackToolExecution());
		}

		this.rebuildImages();
	}

	private clearImages(): void {
		for (const img of this.imageComponents) this.removeChild(img);
		for (const spacer of this.imageSpacers) this.removeChild(spacer);
		this.imageComponents = [];
		this.imageSpacers = [];
	}

	private rebuildImages(): void {
		this.clearImages();
		if (!this.result) return;
		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		const caps = getCapabilities();
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!caps.images || !this.showImages || !img.data || !img.mimeType) continue;
			const converted = this.convertedImages.get(i);
			const imageData = converted?.data ?? img.data;
			const imageMimeType = converted?.mimeType ?? img.mimeType;
			if (caps.images === "kitty" && imageMimeType !== "image/png") continue;
			const spacer = new Spacer(1);
			this.addChild(spacer);
			this.imageSpacers.push(spacer);
			const imageComponent = new Image(
				imageData,
				imageMimeType,
				{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
				{ maxWidthCells: this.imageWidthCells },
			);
			this.imageComponents.push(imageComponent);
			this.addChild(imageComponent);
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatFallbackToolExecution(): string {
		let text = theme.fg(
			"toolTitle",
			this.callDisplayMode === "full"
				? formatFullToolCall(this.toolName, this.args)
				: formatMinimalToolCall(this.toolName, this.args),
		);
		const output = this.getTextOutput();
		if (output) text += `\n${output}`;
		return text;
	}
}
