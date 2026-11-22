import type {
  EmbeddingModelV2,
  LanguageModelV2,
  ProviderV2,
} from "@ai-sdk/provider";

export declare const HALLPASS_BASE_URL = "https://api.hallpassai.com/v1";
export declare const HALLPASS_ENV_API_KEY = "HALLPASS_API_KEY";

export declare const FLAGSHIP_HALLPASS_MODELS: readonly [
  "claude-opus-5.5",
  "claude-sonnet-5.5",
  "gpt-6.1-sol",
  "gpt-5.4",
  "deepseek-v4.1-flash",
  "gemini-4-carbon",
  "kimi-k3.1-pro",
  "qwen3.8-27b",
  "glm-5.3",
  "grok-4.3",
];

export type HallPassFlagshipModelId = (typeof FLAGSHIP_HALLPASS_MODELS)[number];

export type HallPassChatModelId =
  | HallPassFlagshipModelId
  | "claude-opus-4.6"
  | "claude-sonnet-4.6"
  | "claude-haiku-5.5"
  | "claude-fable-5.2"
  | "gpt-6.1-terra"
  | "gpt-6-astra"
  | "gpt-6-sol"
  | "gpt-6-luna"
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna"
  | "gemini-3.5-flash"
  | "llama-3.3-70b"
  | "deepseek-v4.1-flash-1017"
  | (string & {});

export type HallPassEmbeddingModelId =
  | "text-embedding-3-small"
  | "text-embedding-3-large"
  | (string & {});

export type HallPassReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface HallPassChatSettings {
  /**
   * Optional user identifier forwarded to the OpenAI-compatible request body.
   */
  user?: string;

  /**
   * Optional reasoning effort level forwarded as `reasoning_effort` on `/v1/chat/completions`.
   */
  reasoningEffort?: HallPassReasoningEffort;

  /**
   *Simulate streaming if upstream streams are disabled.
   */
  simulateStreaming?: boolean;
}

export interface HallPassEmbeddingSettings {
  /**
   * Optional output vector dimensions where supported by the model.
   */
  dimensions?: number;

  /**
   * Optional user identifier forwarded to the request body.
   */
  user?: string;

  /**
   * Maximum embeddings sent in a single call. Defaults to 2048.
   */
  maxEmbeddingsPerCall?: number;

  /**
   * Whether parallel embedding calls are supported. Defaults to true.
   */
  supportsParallelCalls?: boolean;
}

export interface HallPassProviderSettings {
  /**
   * Base URL for HallPass OpenAI-compatible API calls.
   * Defaults to `process.env.HALLPASS_BASE_URL` or `"https://api.hallpassai.com/v1"`.
   */
  baseURL?: string;

  /**
   * HallPass API key sent in `Authorization: Bearer <apiKey>`.
   * Defaults to `process.env.HALLPASS_API_KEY`.
   */
  apiKey?: string;

  /**
   * Custom HTTP headers merged into every request.
   */
  headers?: Record<string, string>;

  /**
   * Custom URL query parameters appended to every request.
   */
  queryParams?: Record<string, string>;

  /**
   * Custom `fetch` implementation for middleware, proxies, or tests.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Provider identifier prefix. Defaults to `"hallpass"`.
   */
  name?: string;

  /**
   * Include token usage in streaming responses (`stream_options.include_usage`).
   * Defaults to `true`.
   */
  includeUsage?: boolean;

  /**
   * Advertise structured JSON schema output support on language models.
   * Defaults to `true`.
   */
  supportsStructuredOutputs?: boolean;

  /**
   * Optional factory override for `@ai-sdk/openai-compatible`'s `createOpenAICompatible`.
   */
  createOpenAICompatible?: (options: Record<string, unknown>) => unknown;
}

export interface HallPassProvider extends ProviderV2 {
  (modelId: HallPassChatModelId, settings?: HallPassChatSettings): LanguageModelV2;

  readonly specificationVersion: "v2";
  readonly provider: string;
  readonly baseURL: string;

  languageModel(
    modelId: HallPassChatModelId,
    settings?: HallPassChatSettings,
  ): LanguageModelV2;

  chatModel(
    modelId: HallPassChatModelId,
    settings?: HallPassChatSettings,
  ): LanguageModelV2;

  completionModel(
    modelId: HallPassChatModelId,
    settings?: HallPassChatSettings,
  ): LanguageModelV2;

  textEmbeddingModel(
    modelId: HallPassEmbeddingModelId,
    settings?: HallPassEmbeddingSettings,
  ): EmbeddingModelV2<string>;

  embedding(
    modelId: HallPassEmbeddingModelId,
    settings?: HallPassEmbeddingSettings,
  ): EmbeddingModelV2<string>;
}

export declare function resolveHallPassApiKey(
  options?: Pick<HallPassProviderSettings, "apiKey">,
): string | undefined;

export declare function resolveHallPassHeaders(
  options?: Pick<HallPassProviderSettings, "apiKey" | "headers">,
  apiKey?: string,
): Record<string, string>;

export declare function createHallPass(
  options?: HallPassProviderSettings,
): HallPassProvider;

export declare const hallpass: HallPassProvider;
export default hallpass;
