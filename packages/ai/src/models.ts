import { MODELS } from "./models.generated.js";
import type { Api, Model, Usage } from "./types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();
const OPENAI_NATIVE_WEB_SEARCH_APIS = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);
const GOOGLE_NATIVE_WEB_SEARCH_APIS = new Set<Api>(["google-generative-ai", "google-gemini-cli", "google-vertex"]);

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends RegisteredProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

type RegisteredProvider = keyof typeof MODELS;

export function getModel<TProvider extends RegisteredProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): RegisteredProvider[] {
	return Array.from(modelRegistry.keys()) as RegisteredProvider[];
}

export function getModels<TProvider extends RegisteredProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	let webSearchCost = 0;
	const hasWebSearchTracking =
		usage.webSearchCalls !== undefined ||
		model.cost.webSearchPerCall !== undefined ||
		usage.cost.webSearch !== undefined;
	if (hasWebSearchTracking) {
		webSearchCost = (model.cost.webSearchPerCall ?? 0) * (usage.webSearchCalls ?? 0);
		usage.cost.webSearch = webSearchCost;
	}
	usage.cost.total =
		usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite + webSearchCost;
	return usage.cost;
}

function isLikelyOpenAINativeWebSearchModel(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return (
		normalized.startsWith("gpt-") ||
		normalized.startsWith("o1") ||
		normalized.startsWith("o3") ||
		normalized.startsWith("o4") ||
		normalized.includes("/gpt-") ||
		normalized.includes("/o1") ||
		normalized.includes("/o3") ||
		normalized.includes("/o4")
	);
}

function isLikelyGeminiModel(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return normalized.startsWith("gemini-") || normalized.includes("/gemini-");
}

/**
 * Provider-agnostic capability check for native provider web search.
 * This policy is intentionally independent from pricing metadata.
 */
export function supportsNativeWebSearch<TApi extends Api>(model: Model<TApi>): boolean {
	if (OPENAI_NATIVE_WEB_SEARCH_APIS.has(model.api)) {
		return isLikelyOpenAINativeWebSearchModel(model.id);
	}
	if (GOOGLE_NATIVE_WEB_SEARCH_APIS.has(model.api)) {
		return isLikelyGeminiModel(model.id);
	}
	return false;
}

export function shouldEnableNativeWebSearch<TApi extends Api>(
	model: Model<TApi>,
	enableNativeWebSearch: boolean | undefined,
): boolean {
	return enableNativeWebSearch === true && supportsNativeWebSearch(model);
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.2 / GPT-5.3 model families
 * - Anthropic Messages API Opus 4.6 models (xhigh maps to adaptive effort "max")
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.id.includes("gpt-5.2") || model.id.includes("gpt-5.3")) {
		return true;
	}

	if (model.api === "anthropic-messages") {
		return model.id.includes("opus-4-6") || model.id.includes("opus-4.6");
	}

	return false;
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
