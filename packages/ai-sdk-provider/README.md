# @hallpassai/ai-sdk-provider

[HallPass](https://hallpassai.com) provider for the [Vercel AI SDK](https://ai-sdk.dev), wrapping `@ai-sdk/openai-compatible` against `https://api.hallpassai.com/v1`.

## Installation

```bash
npm install @hallpassai/ai-sdk-provider @ai-sdk/openai-compatible ai
```

## Configuration

Set `HALLPASS_API_KEY` in your environment (created in [HallPass API Keys](https://hallpassai.com/start.html#keys)):

```bash
export HALLPASS_API_KEY="hp_live_..."
```

## Usage

### Default Provider Instance

```ts
import { hallpass } from "@hallpassai/ai-sdk-provider";
import { generateText } from "ai";

const { text } = await generateText({
  model: hallpass("claude-sonnet-5.5"),
  prompt: "Explain optimistic concurrency control in Postgres.",
});
```

### Streaming Text

```ts
import { hallpass } from "@hallpassai/ai-sdk-provider";
import { streamText } from "ai";

const result = streamText({
  model: hallpass("gpt-6.1-sol"),
  prompt: "Write a streaming JSON lines parser in Node.js.",
});

for await (const delta of result.textStream) {
  process.stdout.write(delta);
}
```

### Chat models and reasoning

Use `hallpass.chatModel("gpt-6.1-sol")` or `hallpass.chatModel("deepseek-v4.1-flash")` for Chat Completions. Requests use the HallPass key configured in your application. For direct calls to `POST /v1/chat/completions`, set `reasoning_effort` to a level supported by the model. The gateway also accepts the `reasoning` string sent by Cursor Desktop. On `POST /v1/responses`, use a `reasoning` object with an `effort` field.

For Cursor Ask or Agent, run `npx hallpassai setup cursor` and follow the [Cursor setup guide](https://github.com/hallpassai/hallpassai#cursor-desktop).

### Custom Provider Configuration

Use `createHallPass` to override `apiKey`, `baseURL`, custom `headers`, `queryParams`, or `fetch`:

```ts
import { createHallPass } from "@hallpassai/ai-sdk-provider";
import { generateText } from "ai";

const hp = createHallPass({
  apiKey: process.env.HALLPASS_API_KEY,
  headers: {
    "X-Client-Name": "my-service",
  },
});

const { text } = await generateText({
  model: hp.chatModel("deepseek-v4.1-flash"),
  prompt: "Generate a SQL migration adding an index on created_at.",
});
```

### Provider Methods

| Method | Description |
| --- | --- |
| `hallpass(modelId, settings?)` | Returns a chat language model for `modelId`. |
| `hallpass.languageModel(modelId, settings?)` | Returns a chat language model for `modelId`. |
| `hallpass.chatModel(modelId, settings?)` | Returns a chat language model targeting `/v1/chat/completions`. |
| `hallpass.completionModel(modelId, settings?)` | Returns a text completion model. |
| `hallpass.textEmbeddingModel(modelId, settings?)` | Returns a text embedding model targeting `/v1/embeddings`. |

### Flagship Model IDs

TypeScript autocomplete includes flagship catalog IDs alongside arbitrary `(string & {})` model IDs from [`https://hallpassai.com/models.json`](https://hallpassai.com/models.json):

- `claude-opus-5.5`
- `claude-sonnet-5.5`
- `gpt-6.1-sol`
- `gpt-5.4`
- `deepseek-v4.1-flash`
- `gemini-4-carbon`
- `kimi-k3.1-pro`
- `qwen3.8-27b`
- `glm-5.3`
- `grok-4.3`

## Documentation

- [HallPass API & CLI Documentation](https://hallpassai.com/docs.html)
- [Model Catalog & Pricing](https://hallpassai.com/models.json)

## License

MIT
