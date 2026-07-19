import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import {
	Box,
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	imageFallback,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
} from "@mariozechner/pi-tui";
import { convertToPng } from "../../../utils/image-convert.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

type UserMessageContent = TextContent | ImageContent;

export interface UserMessageOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	onImagesChanged?: () => void;
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private content: UserMessageContent[];
	private markdownTheme: MarkdownTheme;
	private showImages: boolean;
	private imageWidthCells: number;
	private onImagesChanged?: () => void;
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();

	constructor(
		content: string | UserMessageContent[],
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		options: UserMessageOptions = {},
	) {
		super();
		this.content = typeof content === "string" ? [{ type: "text", text: content }] : content;
		this.markdownTheme = markdownTheme;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.onImagesChanged = options.onImagesChanged;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
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
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	private updateDisplay(): void {
		this.clear();

		const text = this.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("");

		if (text) {
			const contentBox = new Box(1, 1, (content: string) => theme.bg("userMessageBg", content));
			contentBox.addChild(
				new Markdown(text, 0, 0, this.markdownTheme, {
					color: (content: string) => theme.fg("userMessageText", content),
				}),
			);
			this.addChild(contentBox);
		}

		const imageBlocks = this.content.filter((block): block is ImageContent => block.type === "image");
		const caps = getCapabilities();
		for (let i = 0; i < imageBlocks.length; i++) {
			const image = imageBlocks[i];
			if (!image.data || !image.mimeType) continue;

			if (this.children.length > 0) {
				this.addChild(new Spacer(1));
			}

			if (!caps.images || !this.showImages) {
				const dimensions = getImageDimensions(image.data, image.mimeType) ?? undefined;
				this.addChild(new Text(theme.fg("userMessageText", imageFallback(image.mimeType, dimensions)), 0, 0));
				continue;
			}

			const converted = this.convertedImages.get(i);
			const imageData = converted?.data ?? image.data;
			const imageMimeType = converted?.mimeType ?? image.mimeType;
			if (caps.images === "kitty" && imageMimeType !== "image/png") {
				const dimensions = getImageDimensions(image.data, image.mimeType) ?? undefined;
				this.addChild(new Text(theme.fg("userMessageText", imageFallback(image.mimeType, dimensions)), 0, 0));
				continue;
			}

			this.addChild(
				new Image(
					imageData,
					imageMimeType,
					{ fallbackColor: (content: string) => theme.fg("userMessageText", content) },
					{ maxWidthCells: this.imageWidthCells },
				),
			);
		}
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;

		const imageBlocks = this.content.filter((block): block is ImageContent => block.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const image = imageBlocks[i];
			if (!image.data || !image.mimeType) continue;
			if (image.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(image.data, image.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.onImagesChanged?.();
				}
			});
		}
	}
}
