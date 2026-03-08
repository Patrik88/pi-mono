import type { Api } from "../../../packages/ai/src/types.js";
import type { ModelWithWebSearchCost, UsageWithWebSearch } from "./types.js";
import { supportsNativeWebSearchModel } from "./policy.js";

export const DEFAULT_WEB_SEARCH_PER_CALL = 0.01;

export function getWebSearchPerCall<TApi extends Api>(model: ModelWithWebSearchCost<TApi>): number | undefined {
	if (model.cost.webSearchPerCall !== undefined) {
		return model.cost.webSearchPerCall;
	}
	return supportsNativeWebSearchModel(model) ? DEFAULT_WEB_SEARCH_PER_CALL : undefined;
}

export function applyWebSearchPricing<TApi extends Api>(
	model: ModelWithWebSearchCost<TApi>,
	usage: UsageWithWebSearch,
): void {
	const webSearchPerCall = getWebSearchPerCall(model);
	const webSearchCalls = usage.webSearchCalls ?? 0;
	const webSearchCost = webSearchPerCall === undefined ? 0 : webSearchPerCall * webSearchCalls;

	usage.cost.webSearch = webSearchCost;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite + webSearchCost;
}
