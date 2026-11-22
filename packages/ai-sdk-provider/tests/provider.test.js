import test from "node:test";
import assert from "node:assert/strict";
import {
  HALLPASS_BASE_URL,
  HALLPASS_ENV_API_KEY,
  FLAGSHIP_HALLPASS_MODELS,
  resolveHallPassApiKey,
  resolveHallPassHeaders,
  createHallPass,
  hallpass,
} from "../src/index.js";

function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, val] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  const restore = () => {
    for (const [key, val] of saved.entries()) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

test("exports HALLPASS_BASE_URL, HALLPASS_ENV_API_KEY, and 10 flagship models", () => {
  assert.equal(HALLPASS_BASE_URL, "https://api.hallpassai.com/v1");
  assert.equal(HALLPASS_ENV_API_KEY, "HALLPASS_API_KEY");
  assert.deepEqual(FLAGSHIP_HALLPASS_MODELS, [
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
  assert.equal(Object.isFrozen(FLAGSHIP_HALLPASS_MODELS), true);
});

test("resolves API key from options.apiKey first, then process.env.HALLPASS_API_KEY", () => {
  withEnv({ HALLPASS_API_KEY: "hp_env_secret" }, () => {
    assert.equal(
      resolveHallPassApiKey({ apiKey: "hp_opt_secret" }),
      "hp_opt_secret",
    );
    assert.equal(resolveHallPassApiKey({}), "hp_env_secret");
    assert.equal(resolveHallPassApiKey({ apiKey: "   " }), "hp_env_secret");
  });

  withEnv({ HALLPASS_API_KEY: undefined }, () => {
    assert.equal(resolveHallPassApiKey({}), undefined);
    assert.equal(
      resolveHallPassApiKey({ apiKey: "hp_direct_only" }),
      "hp_direct_only",
    );
  });
});

test("resolves custom headers and Bearer Authorization without case-insensitive duplication", () => {
  const merged = resolveHallPassHeaders(
    { headers: { "X-Custom-Trace": "trace-123" } },
    "hp_key_1",
  );
  assert.deepEqual(merged, {
    Authorization: "Bearer hp_key_1",
    "X-Custom-Trace": "trace-123",
  });

  const explicitLower = resolveHallPassHeaders(
    {
      headers: {
        authorization: "Bearer override_token",
        "X-App": "demo",
      },
    },
    "hp_key_1",
  );
  assert.deepEqual(explicitLower, {
    authorization: "Bearer override_token",
    "X-App": "demo",
  });
});

test("createHallPass delegates cleanly to @ai-sdk/openai-compatible factory when provided", () => {
  const calls = [];
  const mockFactory = (cfg) => {
    calls.push(cfg);
    const fn = (id, settings) => ({ kind: "default", id, settings, cfg });
    fn.languageModel = (id, settings) => ({
      kind: "languageModel",
      id,
      settings,
    });
    fn.chatModel = (id, settings) => ({ kind: "chatModel", id, settings });
    fn.completionModel = (id, settings) => ({
      kind: "completionModel",
      id,
      settings,
    });
    fn.textEmbeddingModel = (id, settings) => ({
      kind: "textEmbeddingModel",
      id,
      settings,
    });
    return fn;
  };

  const provider = createHallPass({
    apiKey: "hp_live_abc",
    baseURL: "https://api.hallpassai.com/v1///",
    headers: { "X-Client": "unit-test" },
    queryParams: { version: "2026-11" },
    createOpenAICompatible: mockFactory,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "hallpass");
  assert.equal(calls[0].baseURL, "https://api.hallpassai.com/v1");
  assert.equal(calls[0].apiKey, "hp_live_abc");
  assert.deepEqual(calls[0].headers, {
    Authorization: "Bearer hp_live_abc",
    "X-Client": "unit-test",
  });
  assert.deepEqual(calls[0].queryParams, { version: "2026-11" });
  assert.equal(calls[0].includeUsage, true);
  assert.equal(calls[0].supportsStructuredOutputs, true);

  assert.deepEqual(provider("claude-sonnet-5.5", { user: "u1" }), {
    kind: "languageModel",
    id: "claude-sonnet-5.5",
    settings: { user: "u1" },
  });
  assert.deepEqual(provider.chatModel("gpt-6.1-sol"), {
    kind: "chatModel",
    id: "gpt-6.1-sol",
    settings: undefined,
  });
  assert.deepEqual(provider.languageModel("deepseek-v4.1-flash"), {
    kind: "languageModel",
    id: "deepseek-v4.1-flash",
    settings: undefined,
  });
  assert.deepEqual(provider.completionModel("qwen3.8-27b"), {
    kind: "completionModel",
    id: "qwen3.8-27b",
    settings: undefined,
  });
  assert.deepEqual(provider.textEmbeddingModel("text-embedding-3-small"), {
    kind: "textEmbeddingModel",
    id: "text-embedding-3-small",
    settings: undefined,
  });
});

test("forbids calling createHallPass or model functions with `new` and validates modelId", () => {
  assert.throws(() => new createHallPass(), /cannot be called with the new keyword/);
  const provider = createHallPass({ apiKey: "hp_test" });
  assert.throws(() => new provider("gpt-5.4"), /cannot be called with the new keyword/);
  assert.throws(() => new hallpass("gpt-5.4"), /cannot be called with the new keyword/);
  assert.throws(() => provider(""), TypeError);
  assert.throws(() => provider.chatModel("   "), TypeError);
  assert.throws(() => provider.textEmbeddingModel(null), TypeError);
});

test("standalone chatModel/languageModel sends OpenAI-compatible POST /chat/completions with resolved key and headers", async () => {
  await withEnv(
    { HALLPASS_API_KEY: "hp_from_env", HALLPASS_BASE_URL: undefined },
    async () => {
      let capturedUrl = null;
      let capturedInit = null;

      const customFetch = async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(
          JSON.stringify({
            id: "chatcmpl_123",
            model: "claude-sonnet-5.5",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "pong" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 9,
              completion_tokens: 1,
              total_tokens: 10,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      };

      const hp = createHallPass({
        headers: { "X-Harness": "ai-sdk-test" },
        fetch: customFetch,
      });

      const model = hp.chatModel("claude-sonnet-5.5", {
        reasoningEffort: "high",
      });
      assert.equal(model.modelId, "claude-sonnet-5.5");
      assert.equal(model.provider, "hallpass.chat");

      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
        temperature: 0.2,
        headers: { "X-Request-Id": "req-99" },
      });

      assert.equal(
        capturedUrl,
        "https://api.hallpassai.com/v1/chat/completions",
      );
      assert.equal(capturedInit.method, "POST");
      assert.equal(capturedInit.headers.Authorization, "Bearer hp_from_env");
      assert.equal(capturedInit.headers["X-Harness"], "ai-sdk-test");
      assert.equal(capturedInit.headers["X-Request-Id"], "req-99");

      const parsedBody = JSON.parse(capturedInit.body);
      assert.equal(parsedBody.model, "claude-sonnet-5.5");
      assert.equal(parsedBody.reasoning_effort, "high");
      assert.equal(parsedBody.temperature, 0.2);
      assert.deepEqual(parsedBody.messages, [{ role: "user", content: "ping" }]);

      assert.deepEqual(result.content, [{ type: "text", text: "pong" }]);
      assert.equal(result.finishReason, "stop");
      assert.deepEqual(result.usage, {
        inputTokens: 9,
        outputTokens: 1,
        totalTokens: 10,
      });
    },
  );
});

test("default `hallpass` instance resolves process.env.HALLPASS_API_KEY lazily and supports textEmbeddingModel", async () => {
  await withEnv(
    {
      HALLPASS_API_KEY: undefined,
      HALLPASS_BASE_URL: "https://api.hallpassai.com/v1/",
    },
    async () => {
      assert.equal(hallpass.baseURL, "https://api.hallpassai.com/v1");

      const missingKeyModel = hallpass("gpt-6.1-sol");
      await assert.rejects(
        () => missingKeyModel.doGenerate({ prompt: "hello" }),
        /HALLPASS_API_KEY/,
      );

      process.env.HALLPASS_API_KEY = "hp_late_bound_key";
      const prevFetch = globalThis.fetch;
      let embedRequest = null;
      globalThis.fetch = async (url, init) => {
        embedRequest = { url, init };
        return new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: [0.125, -0.5, 0.875] }],
            usage: { prompt_tokens: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      try {
        const embedModel = hallpass.textEmbeddingModel(
          "text-embedding-3-small",
          { dimensions: 3 },
        );
        const res = await embedModel.doEmbed({ values: ["hello world"] });
        assert.equal(
          embedRequest.url,
          "https://api.hallpassai.com/v1/embeddings",
        );
        assert.equal(
          embedRequest.init.headers.Authorization,
          "Bearer hp_late_bound_key",
        );
        assert.deepEqual(JSON.parse(embedRequest.init.body), {
          model: "text-embedding-3-small",
          input: ["hello world"],
          dimensions: 3,
        });
        assert.deepEqual(res.embeddings, [[0.125, -0.5, 0.875]]);
        assert.deepEqual(res.usage, { tokens: 4 });
      } finally {
        globalThis.fetch = prevFetch;
      }
    },
  );
});
