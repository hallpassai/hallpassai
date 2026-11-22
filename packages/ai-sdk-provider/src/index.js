export const HALLPASS_BASE_URL = "https://api.hallpassai.com/v1";
export const HALLPASS_ENV_API_KEY = "HALLPASS_API_KEY";

export const FLAGSHIP_HALLPASS_MODELS = Object.freeze([
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
]);

let installedOpenAICompatible = null;
try {
  const mod = await import("@ai-sdk/openai-compatible");
  if (typeof mod?.createOpenAICompatible === "function") {
    installedOpenAICompatible = mod.createOpenAICompatible;
  }
} catch {
  installedOpenAICompatible = null;
}

function normalizeBaseURL(rawUrl) {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  const resolved = trimmed || HALLPASS_BASE_URL;
  return resolved.replace(/\/+$/, "");
}

export function resolveHallPassApiKey(options = {}) {
  if (typeof options.apiKey === "string" && options.apiKey.trim()) {
    return options.apiKey.trim();
  }
  const envKey = process.env[HALLPASS_ENV_API_KEY];
  if (typeof envKey === "string" && envKey.trim()) {
    return envKey.trim();
  }
  return undefined;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const clean = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      clean[key] = String(value);
    }
  }
  return clean;
}

export function resolveHallPassHeaders(
  options = {},
  apiKey = resolveHallPassApiKey(options),
) {
  const custom = sanitizeHeaders(options.headers);
  const hasExplicitAuth = Object.keys(custom).some(
    (key) => key.toLowerCase() === "authorization",
  );
  if (apiKey && !hasExplicitAuth) {
    return {
      Authorization: `Bearer ${apiKey}`,
      ...custom,
    };
  }
  return custom;
}

function assertValidModelId(modelId, methodName) {
  if (typeof modelId !== "string" || !modelId.trim()) {
    throw new TypeError(
      `HallPass ${methodName} requires a non-empty modelId string.`,
    );
  }
  return modelId.trim();
}

function buildEndpointUrl(baseURL, routePath, queryParams) {
  const url = new URL(`${baseURL}${routePath}`);
  if (queryParams && typeof queryParams === "object") {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function ensureAuthorizedHeaders(baseHeaders, requestHeaders) {
  const merged = {
    "Content-Type": "application/json",
    ...baseHeaders,
    ...sanitizeHeaders(requestHeaders),
  };
  const hasAuth = Object.keys(merged).some(
    (key) => key.toLowerCase() === "authorization",
  );
  if (!hasAuth) {
    throw new Error(
      "HallPass API key is missing. Pass `apiKey` to `createHallPass({ apiKey })` or set the `HALLPASS_API_KEY` environment variable.",
    );
  }
  return merged;
}

function promptToMessages(prompt) {
  if (typeof prompt === "string") {
    return [{ role: "user", content: prompt }];
  }
  if (!Array.isArray(prompt)) return [];
  return prompt.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return { role: "user", content: String(entry ?? "") };
    }
    if (typeof entry.content === "string") {
      return { role: entry.role ?? "user", content: entry.content };
    }
    if (Array.isArray(entry.content)) {
      const textParts = entry.content
        .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
        .filter(Boolean);
      return {
        role: entry.role ?? "user",
        content: textParts.join("\n"),
      };
    }
    return { role: entry.role ?? "user", content: "" };
  });
}

function mapFinishReason(reason) {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "tool_calls" || reason === "function_call") return "tool-calls";
  if (reason === "content_filter") return "content-filter";
  return "other";
}

function createStandaloneChatModel(modelId, settings = {}, config) {
  const fetcher = config.fetch ?? globalThis.fetch;
  return {
    specificationVersion: "v2",
    provider: `${config.name}.chat`,
    modelId,
    settings,
    supportsStructuredOutputs: Boolean(config.supportsStructuredOutputs),
    supportedUrls: {
      "image/*": [/^https?:\/\//i],
      "application/pdf": [/^https?:\/\//i],
    },
    async doGenerate(callOptions = {}) {
      const headers = ensureAuthorizedHeaders(
        config.headers,
        callOptions.headers,
      );
      const url = buildEndpointUrl(
        config.baseURL,
        "/chat/completions",
        config.queryParams,
      );
      const reasoningEffort =
        callOptions.providerOptions?.hallpass?.reasoningEffort ??
        settings.reasoningEffort;
      const body = {
        model: modelId,
        messages: promptToMessages(callOptions.prompt),
        ...(callOptions.maxOutputTokens !== undefined
          ? { max_completion_tokens: callOptions.maxOutputTokens }
          : {}),
        ...(callOptions.temperature !== undefined
          ? { temperature: callOptions.temperature }
          : {}),
        ...(callOptions.topP !== undefined ? { top_p: callOptions.topP } : {}),
        ...(callOptions.stopSequences !== undefined
          ? { stop: callOptions.stopSequences }
          : {}),
        ...(callOptions.seed !== undefined ? { seed: callOptions.seed } : {}),
        ...(reasoningEffort !== undefined
          ? { reasoning_effort: reasoningEffort }
          : {}),
        ...(settings.user !== undefined ? { user: settings.user } : {}),
      };
      if (callOptions.responseFormat?.type === "json") {
        body.response_format = callOptions.responseFormat.schema
          ? {
              type: "json_schema",
              json_schema: {
                name: callOptions.responseFormat.name ?? "response",
                strict: true,
                schema: callOptions.responseFormat.schema,
              },
            }
          : { type: "json_object" };
      }

      const response = await fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: callOptions.abortSignal,
      });
      const rawText = await response.text();
      if (!response.ok) {
        const error = new Error(
          `HallPass request failed with status ${response.status}: ${rawText}`,
        );
        error.statusCode = response.status;
        error.responseBody = rawText;
        throw error;
      }
      const data = JSON.parse(rawText);
      const choice = data?.choices?.[0] ?? {};
      const text = choice?.message?.content ?? "";
      const content = text ? [{ type: "text", text }] : [];

      return {
        content,
        finishReason: mapFinishReason(choice?.finish_reason),
        usage: {
          inputTokens: data?.usage?.prompt_tokens,
          outputTokens: data?.usage?.completion_tokens,
          totalTokens: data?.usage?.total_tokens,
        },
        request: { body },
        response: {
          id: data?.id,
          modelId: data?.model ?? modelId,
          headers: Object.fromEntries(response.headers.entries()),
          body: data,
        },
        warnings: [],
      };
    },
    async doStream(callOptions = {}) {
      const headers = ensureAuthorizedHeaders(
        config.headers,
        callOptions.headers,
      );
      const url = buildEndpointUrl(
        config.baseURL,
        "/chat/completions",
        config.queryParams,
      );
      const reasoningEffort =
        callOptions.providerOptions?.hallpass?.reasoningEffort ??
        settings.reasoningEffort;
      const body = {
        model: modelId,
        stream: true,
        ...(config.includeUsage
          ? { stream_options: { include_usage: true } }
          : {}),
        messages: promptToMessages(callOptions.prompt),
        ...(reasoningEffort !== undefined
          ? { reasoning_effort: reasoningEffort }
          : {}),
      };

      const response = await fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: callOptions.abortSignal,
      });
      if (!response.ok || !response.body) {
        const rawText = await response.text();
        const error = new Error(
          `HallPass stream failed with status ${response.status}: ${rawText}`,
        );
        error.statusCode = response.status;
        error.responseBody = rawText;
        throw error;
      }
      return {
        stream: response.body,
        request: { body },
        response: {
          headers: Object.fromEntries(response.headers.entries()),
        },
      };
    },
  };
}

function createStandaloneCompletionModel(modelId, settings = {}, config) {
  return {
    ...createStandaloneChatModel(modelId, settings, config),
    provider: `${config.name}.completion`,
  };
}

function createStandaloneEmbeddingModel(modelId, settings = {}, config) {
  const fetcher = config.fetch ?? globalThis.fetch;
  return {
    specificationVersion: "v2",
    provider: `${config.name}.embedding`,
    modelId,
    settings,
    maxEmbeddingsPerCall: settings.maxEmbeddingsPerCall ?? 2048,
    supportsParallelCalls: settings.supportsParallelCalls ?? true,
    async doEmbed(callOptions = {}) {
      const headers = ensureAuthorizedHeaders(
        config.headers,
        callOptions.headers,
      );
      const url = buildEndpointUrl(
        config.baseURL,
        "/embeddings",
        config.queryParams,
      );
      const body = {
        model: modelId,
        input: callOptions.values ?? [],
        ...(settings.dimensions !== undefined
          ? { dimensions: settings.dimensions }
          : {}),
        ...(settings.user !== undefined ? { user: settings.user } : {}),
      };
      const response = await fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: callOptions.abortSignal,
      });
      const rawText = await response.text();
      if (!response.ok) {
        const error = new Error(
          `HallPass embedding request failed with status ${response.status}: ${rawText}`,
        );
        error.statusCode = response.status;
        error.responseBody = rawText;
        throw error;
      }
      const data = JSON.parse(rawText);
      const embeddings = Array.isArray(data?.data)
        ? data.data.map((item) => item.embedding)
        : [];
      return {
        embeddings,
        usage:
          data?.usage?.prompt_tokens !== undefined
            ? { tokens: data.usage.prompt_tokens }
            : undefined,
        response: {
          headers: Object.fromEntries(response.headers.entries()),
          body: data,
        },
      };
    },
  };
}

function createStandaloneOpenAICompatible(config) {
  const chatModel = (modelId, settings) =>
    createStandaloneChatModel(
      assertValidModelId(modelId, "chatModel"),
      settings,
      config,
    );
  const completionModel = (modelId, settings) =>
    createStandaloneCompletionModel(
      assertValidModelId(modelId, "completionModel"),
      settings,
      config,
    );
  const textEmbeddingModel = (modelId, settings) =>
    createStandaloneEmbeddingModel(
      assertValidModelId(modelId, "textEmbeddingModel"),
      settings,
      config,
    );

  const provider = function hallpassCompatibleModel(modelId, settings) {
    if (new.target) {
      throw new Error(
        "The HallPass model function cannot be called with the new keyword.",
      );
    }
    return chatModel(modelId, settings);
  };
  provider.languageModel = chatModel;
  provider.chatModel = chatModel;
  provider.completionModel = completionModel;
  provider.textEmbeddingModel = textEmbeddingModel;
  return provider;
}

export function createHallPass(options = {}) {
  if (new.target) {
    throw new Error(
      "The HallPass provider factory cannot be called with the new keyword.",
    );
  }
  const name = options.name ?? "hallpass";
  const baseURL = normalizeBaseURL(
    options.baseURL ?? process.env.HALLPASS_BASE_URL ?? HALLPASS_BASE_URL,
  );
  const apiKey = resolveHallPassApiKey(options);
  const headers = resolveHallPassHeaders(options, apiKey);
  const includeUsage = options.includeUsage ?? true;
  const supportsStructuredOutputs = options.supportsStructuredOutputs ?? true;

  const factory =
    options.createOpenAICompatible ??
    installedOpenAICompatible ??
    createStandaloneOpenAICompatible;

  const compatibleOptions = {
    name,
    baseURL,
    ...(apiKey !== undefined ? { apiKey } : {}),
    headers,
    ...(options.queryParams ? { queryParams: options.queryParams } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    includeUsage,
    supportsStructuredOutputs,
  };

  const baseProvider = factory(compatibleOptions);

  const chatModel = (modelId, settings) => {
    const validId = assertValidModelId(modelId, "chatModel");
    if (typeof baseProvider.chatModel === "function") {
      return baseProvider.chatModel(validId, settings);
    }
    return baseProvider(validId, settings);
  };

  const languageModel = (modelId, settings) => {
    const validId = assertValidModelId(modelId, "languageModel");
    if (typeof baseProvider.languageModel === "function") {
      return baseProvider.languageModel(validId, settings);
    }
    return chatModel(validId, settings);
  };

  const completionModel = (modelId, settings) => {
    const validId = assertValidModelId(modelId, "completionModel");
    if (typeof baseProvider.completionModel === "function") {
      return baseProvider.completionModel(validId, settings);
    }
    return createStandaloneCompletionModel(validId, settings, compatibleOptions);
  };

  const textEmbeddingModel = (modelId, settings) => {
    const validId = assertValidModelId(modelId, "textEmbeddingModel");
    if (typeof baseProvider.textEmbeddingModel === "function") {
      return baseProvider.textEmbeddingModel(validId, settings);
    }
    if (typeof baseProvider.embedding === "function") {
      return baseProvider.embedding(validId, settings);
    }
    return createStandaloneEmbeddingModel(validId, settings, compatibleOptions);
  };

  const provider = function hallpassProvider(modelId, settings) {
    if (new.target) {
      throw new Error(
        "The HallPass model function cannot be called with the new keyword.",
      );
    }
    return languageModel(modelId, settings);
  };

  provider.specificationVersion = baseProvider.specificationVersion ?? "v2";
  provider.provider = name;
  provider.baseURL = baseURL;
  provider.languageModel = languageModel;
  provider.chatModel = chatModel;
  provider.completionModel = completionModel;
  provider.textEmbeddingModel = textEmbeddingModel;
  provider.embedding = textEmbeddingModel;

  return provider;
}

function createDefaultHallPassProvider() {
  const defaultProvider = function hallpassDefault(modelId, settings) {
    if (new.target) {
      throw new Error(
        "The HallPass model function cannot be called with the new keyword.",
      );
    }
    return createHallPass().languageModel(modelId, settings);
  };

  defaultProvider.specificationVersion = "v2";
  defaultProvider.provider = "hallpass";
  Object.defineProperty(defaultProvider, "baseURL", {
    enumerable: true,
    get() {
      return normalizeBaseURL(process.env.HALLPASS_BASE_URL ?? HALLPASS_BASE_URL);
    },
  });
  defaultProvider.languageModel = (modelId, settings) =>
    createHallPass().languageModel(modelId, settings);
  defaultProvider.chatModel = (modelId, settings) =>
    createHallPass().chatModel(modelId, settings);
  defaultProvider.completionModel = (modelId, settings) =>
    createHallPass().completionModel(modelId, settings);
  defaultProvider.textEmbeddingModel = (modelId, settings) =>
    createHallPass().textEmbeddingModel(modelId, settings);
  defaultProvider.embedding = defaultProvider.textEmbeddingModel;

  return defaultProvider;
}

export const hallpass = createDefaultHallPassProvider();
export default hallpass;
