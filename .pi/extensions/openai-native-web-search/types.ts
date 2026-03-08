import type { Api, AssistantMessage, Model, Usage } from "../../../packages/ai/src/types.js";

export type NativeWebSearchDisableReason =
	| "not_opted_in"
	| "unsupported_provider"
	| "unsupported_model"
	| "gpt5_minimal_reasoning";

export interface NativeWebSearchDecision {
	enabled: boolean;
	reason?: NativeWebSearchDisableReason;
}

export interface NativeWebSearchState {
	enabled: boolean;
	source: "default" | "session" | "flag";
}

export interface ModelWithWebSearchCost<TApi extends Api = Api> extends Model<TApi> {
	cost: Model<TApi>["cost"] & {
		webSearchPerCall?: number;
	};
}

export interface UsageWithWebSearch extends Usage {
	webSearchCalls?: number;
	cost: Usage["cost"] & {
		webSearch?: number;
	};
}

export interface AssistantMessageWithWebSearch extends AssistantMessage {
	usage: UsageWithWebSearch;
}
