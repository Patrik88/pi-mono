import OpenAI from "openai";
import type { ResponseCreateParamsStreaming, Tool as OpenAITool } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../../../packages/ai/src/env-api-keys.js";
import { supportsXhigh } from "../../../packages/ai/src/models.js";
import { streamSimpleOpenAIResponses } from "../../../packages/ai/src/providers/openai-responses.js";
import { convertResponsesMessages, convertResponsesTools } from "../../../packages/ai/src/providers/openai-responses-shared.js";
import { buildBaseOptions, clampReasoning } from "../../../packages/ai/src/providers/simple-options.js";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../../../packages/ai/src/types.js";
import { AssistantMessageEventStream } from "../../../packages/ai/src/utils/event-stream.js";
import { processResponsesStreamWithNativeWebSearch } from "./openai-stream.js";
import { evaluateNativeWebSearchPolicy } from "./policy.js";
import { extractDirectiveContext } from "./state.js";
import type { AssistantMessageWithWebSearch, ModelWithWebSearchCost } from "./types.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

export interface BuildOpenAIResponsesParamsResult {
	params: ResponseCreateParamsStreaming;
	context: Context;
	decision: ReturnType<typeof evaluateNativeWebSearchPolicy>;
}

function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

function getPromptCacheRetention(baseUrl: string, cacheRetention: CacheRetention): "24h" | undefined {
	if (cacheRetention !== "long") {
		return undefined;
	}
	if (baseUrl.includes("api.openai.com")) {
		return "24h";
	}
	return undefined;
}

function includeValues(
	params: ResponseCreateParamsStreaming,
	values: NonNullable<ResponseCreateParamsStreaming["include"]>,
): void {
	const includeSet = new Set(params.include ?? []);
	for (const value of values) {
		includeSet.add(value);
	}
	params.include = Array.from(includeSet);
}

function convertResponsesToolsWithNativeWebSearch(
	tools: Context["tools"],
	includeNativeWebSearch: boolean,
): OpenAITool[] | undefined {
	const mappedTools = tools ? convertResponsesTools(tools) : [];
	if (includeNativeWebSearch) {
		mappedTools.push({ type: "web_search" });
	}
	return mappedTools.length > 0 ? mappedTools : undefined;
}

function createClient(model: Model<"openai-responses">, apiKey: string, headers?: Record<string, string>): OpenAI {
	const mergedHeaders = { ...model.headers, ...headers };
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: mergedHeaders,
	});
}

export function buildOpenAIResponsesParams(
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): BuildOpenAIResponsesParamsResult {
	const { context: cleanContext, optedIn } = extractDirectiveContext(context);
	const decision = evaluateNativeWebSearchPolicy(model, options?.reasoningEffort, optedIn);
	const messages = convertResponsesMessages(model, cleanContext, OPENAI_TOOL_CALL_PROVIDERS);
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
		prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options.maxTokens;
	}
	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	const mappedTools = convertResponsesToolsWithNativeWebSearch(cleanContext.tools, decision.enabled);
	if (mappedTools) {
		params.tools = mappedTools;
	}
	if (decision.enabled) {
		includeValues(params, ["web_search_call.results", "web_search_call.action.sources"]);
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			params.reasoning = {
				effort: options?.reasoningEffort || "medium",
				summary: options?.reasoningSummary || "auto",
			};
			includeValues(params, ["reasoning.encrypted_content"]);
		} else if (model.name.startsWith("gpt-5")) {
			messages.push({
				role: "developer",
				content: [{ type: "input_text", text: "# Juice: 0 !important" }],
			});
		}
	}

	return {
		params,
		context: cleanContext,
		decision,
	};
}

const streamOpenAIResponsesWithNativeWebSearch: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessageWithWebSearch = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const { params } = buildOpenAIResponsesParams(model, context, options);
			options?.onPayload?.(params);
			const client = createClient(model, apiKey, options?.headers);
			const openaiStream = await client.responses.create(params, options?.signal ? { signal: options.signal } : undefined);
			stream.push({ type: "start", partial: output as AssistantMessage });

			await processResponsesStreamWithNativeWebSearch(
				openaiStream,
				output,
				stream,
				model as ModelWithWebSearchCost<"openai-responses">,
				{ serviceTier: options?.serviceTier },
			);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output as AssistantMessage });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output as AssistantMessage });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleOpenAIResponsesWithNativeWebSearch: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const reasoningEffort = supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning);
	const responseOptions: OpenAIResponsesOptions = {
		...base,
		reasoningEffort,
	};
	const { context: cleanContext, decision } = buildOpenAIResponsesParams(model, context, responseOptions);
	if (!decision.enabled) {
		return streamSimpleOpenAIResponses(model, cleanContext, options);
	}
	return streamOpenAIResponsesWithNativeWebSearch(model, context, responseOptions);
};
