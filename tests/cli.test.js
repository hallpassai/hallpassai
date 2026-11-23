import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawnSync, execFile } from "node:child_process";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import {
  configureAgent,
  addModelToAgent,
  pauseAgent,
  resumeAgent,
  undoAgent,
  inspectAgentConfig,
  detectExistingSubscription,
  switchAgentModel,
  buildEphemeralLaunchSpec,
  upsertCodexToml,
  stripJsonc,
  normalizeCode,
  resolveOrigin,
  originFromApiBase,
  revokeServerToken,
  sendCliEvent,
  validateEndpointUrl,
  validateClaimPayload,
  shSingleQuote,
  upsertShellBlock,
  helperScriptPath,
} from "../src/index.js";
import {
  main as cliMain,
  parseArgs,
  normalizeAgentName,
  orderModelsWithPopularFirst,
  filterModelsByQuery,
  pickModelInteractive,
} from "../bin/cli.js";

const execFileAsync = promisify(execFile);

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-cli-test-"));
  const prevCfg = process.env.HALLPASS_CONFIG_DIR;
  const prevDisableKc = process.env.HALLPASS_DISABLE_KEYCHAIN;
  process.env.HALLPASS_CONFIG_DIR = path.join(dir, ".config", "hallpass");
  process.env.HALLPASS_DISABLE_KEYCHAIN = "1";
  try {
    return fn(dir);
  } finally {
    if (prevCfg === undefined) delete process.env.HALLPASS_CONFIG_DIR;
    else process.env.HALLPASS_CONFIG_DIR = prevCfg;
    if (prevDisableKc === undefined) delete process.env.HALLPASS_DISABLE_KEYCHAIN;
    else process.env.HALLPASS_DISABLE_KEYCHAIN = prevDisableKc;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE_PAYLOAD = {
  token: "hp_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefg",
  apiBase: "https://api.hallpassai.com/v1",
  model: "claude-sonnet-4-6",
  models: [
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      protocols: ["messages", "chat/completions"],
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      protocols: ["responses", "chat/completions"],
      inputPerMillion: 5,
      outputPerMillion: 22.5,
      cacheReadPerMillion: 0.5,
    },
  ],
};

test("pairing code normalization and environment origin routing", () => {
  assert.deepEqual(normalizeCode("hp_9x4k_7m2p"), {
    prefix: "HP",
    code: "HP-9X4K-7M2P",
  });
  assert.deepEqual(normalizeCode("  hpd-abcd-2345 "), {
    prefix: "HPD",
    code: "HPD-ABCD-2345",
  });
  assert.equal(normalizeCode("HP-0000-1111"), null);
  assert.equal(normalizeCode("rm -rf /"), null);
  assert.equal(resolveOrigin("HP"), "https://app.hallpassai.com");
  assert.equal(resolveOrigin("HPD"), "https://dev.hallpassai.com");
  assert.equal(resolveOrigin("HPL"), "http://127.0.0.1:4317");
});

test("security: endpoint & claim payload validation rejects HTTP non-loopback, credentials, and foreign apiBase exfiltration", () => {
  assert.throws(
    () => validateEndpointUrl("http://evil.example/v1"),
    /HTTPS is required/,
  );
  assert.throws(
    () => validateEndpointUrl("https://user:pass@api.hallpassai.com/v1"),
    /credentials/,
  );
  assert.throws(
    () =>
      validateClaimPayload(
        {
          token: SAMPLE_PAYLOAD.token,
          apiBase: "https://evil.example/v1",
          harness: "claude-code",
          model: "claude-sonnet-4-6",
        },
        "https://app.hallpassai.com",
      ),
    /Untrusted apiBase host/,
  );
  const valid = validateClaimPayload(
    {
      token: SAMPLE_PAYLOAD.token,
      apiBase: "https://api.hallpassai.com/v1",
      harness: "claude-code",
      model: "claude-sonnet-4-6",
      progressToken: "hp_pair_" + "a".repeat(43),
      models: [{ id: "__proto__", name: "bad" }, ...SAMPLE_PAYLOAD.models],
    },
    "https://app.hallpassai.com",
  );
  assert.equal(valid.models.length, 2);
});

test("security: shell single-quoting neutralizes command substitution and rejects control characters", () => {
  const quoted = shSingleQuote("$(touch /tmp/pwned) `id` 'quote'");
  assert.equal(quoted, "'$(touch /tmp/pwned) `id` '\\''quote'\\'''");
  assert.throws(() => shSingleQuote("bad\nline"), /control characters/);

  const shellCheck = spawnSync(
    "/bin/sh",
    ["-c", `X=${quoted}; printf '%s' "$X"`],
    { encoding: "utf8" },
  );
  assert.equal(shellCheck.status, 0);
  assert.equal(shellCheck.stdout, "$(touch /tmp/pwned) `id` 'quote'");

  const rc = upsertShellBlock("", "/Users/o'connor/my dir/copilot.env");
  assert.match(rc, /'\/Users\/o'\\''connor\/my dir\/copilot\.env'/);
});

test("security: refuses symlink overwrite and cleans fresh-install secrets on undo without .bak", () =>
  withTempHome((home) => {
    // 1. Fresh install across claude-code, codex, opencode, copilot (no pre-existing files / no .bak)
    configureAgent("claude-code", SAMPLE_PAYLOAD, { homeDir: home });
    configureAgent("codex", SAMPLE_PAYLOAD, { homeDir: home });
    configureAgent("opencode", SAMPLE_PAYLOAD, { homeDir: home });
    configureAgent("copilot", SAMPLE_PAYLOAD, { homeDir: home, shell: "/bin/zsh" });

    // Undo must remove all newly written secret files even when no .hallpass.bak existed
    undoAgent("all", { homeDir: home, shell: "/bin/zsh" });
    assert.equal(
      fs.existsSync(path.join(home, ".local", "share", "opencode", "auth.json")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(home, ".claude", "settings.json")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(home, ".codex", "config.toml")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(home, ".config", "hallpass", "copilot.env")),
      false,
    );

    // 2. Symlink protection
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const targetFile = path.join(home, "outside.json");
    fs.writeFileSync(targetFile, "{}");
    fs.symlinkSync(targetFile, path.join(claudeDir, "settings.json"));
    assert.throws(
      () => configureAgent("claude-code", SAMPLE_PAYLOAD, { homeDir: home }),
      /symlink/,
    );
  }));

test("claude-code adapter merges JSONC settings.json non-destructively, redacts dry-run, and undoes cleanly", () =>
  withTempHome((home) => {
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      `{\n  // user comment\n  "permissions": { "allow": ["Bash(git status)"], },\n  "env": { "FOO": "bar" }\n}\n`,
    );

    const dry = configureAgent("claude-code", SAMPLE_PAYLOAD, {
      homeDir: home,
      dryRun: true,
    });
    assert.ok(!dry.preview.includes(SAMPLE_PAYLOAD.token), "dryRun must redact token");

    const res = configureAgent("claude-code", SAMPLE_PAYLOAD, { homeDir: home });
    assert.ok(res.backup?.endsWith(".hallpass.bak"));

    const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.permissions, { allow: ["Bash(git status)"] });
    assert.equal(written.env.FOO, "bar");
    assert.equal(written.env.ANTHROPIC_BASE_URL, "https://api.hallpassai.com");
    assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, SAMPLE_PAYLOAD.token);
    assert.equal(written.env.ANTHROPIC_API_KEY, "");
    assert.equal(written.env.ANTHROPIC_MODEL, "claude-sonnet-4-6");

    undoAgent("claude-code", { homeDir: home });
    const restored = JSON.parse(
      fs.readFileSync(settingsPath, "utf8").replace(/\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
    );
    assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(restored.env.FOO, "bar");
  }));

test("codex adapter preserves [[array_of_tables]] & commented sections and runs helper cleanly on paths with spaces", () =>
  withTempHome((baseDir) => {
    const home = path.join(baseDir, "spaced home");
    process.env.HALLPASS_CONFIG_DIR = path.join(home, ".config", "hallpass");
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        'model = "o3"',
        "",
        "[model_providers.hallpass]",
        'name = "Old"',
        "",
        "[[notify]] # user array table after hallpass",
        'command = "echo"',
        "",
        "[mcp_servers.demo] # inline comment",
        'command = "npx"',
        "",
      ].join("\n"),
    );

    configureAgent("codex", SAMPLE_PAYLOAD, { homeDir: home });
    const toml = fs.readFileSync(configPath, "utf8");
    assert.ok(!toml.includes(SAMPLE_PAYLOAD.token));
    assert.match(toml, /\[\[notify\]\]/);
    assert.match(toml, /\[mcp_servers\.demo\]/);
    assert.match(toml, /wire_api = "responses"/);

    // Execute generated read-key.mjs inside spaced directory path
    const helper = helperScriptPath(home);
    const { NODE_TEST_CONTEXT: _ntc1, ...cleanEnv1 } = process.env;
    const out = spawnSync(process.execPath, [helper, "codex"], {
      env: { ...cleanEnv1, HALLPASS_DISABLE_KEYCHAIN: "1" },
      encoding: "utf8",
    });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, SAMPLE_PAYLOAD.token);
  }));

test("opencode adapter writes opencode.json provider and 0600 auth.json with type:api", () =>
  withTempHome((home) => {
    configureAgent("opencode", SAMPLE_PAYLOAD, {
      homeDir: home,
      reasoningEffort: "high",
    });
    const cfgPath = path.join(home, ".config", "opencode", "opencode.json");
    const authPath = path.join(home, ".local", "share", "opencode", "auth.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.provider.hallpass.npm, "@ai-sdk/openai-compatible");
    assert.equal(cfg.provider.hallpass.options.baseURL, "https://api.hallpassai.com/v1");
    assert.deepEqual(cfg.provider.hallpass.models["claude-sonnet-4-6"].limit, {
      context: 128000,
      output: 16384,
    });
    assert.deepEqual(cfg.provider.hallpass.models["claude-sonnet-4-6"].cost, {
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    });
    assert.deepEqual(cfg.provider.hallpass.models["claude-sonnet-4-6"].options, {
      reasoningEffort: "high",
    });
    assert.equal(
      cfg.provider.hallpass.models["claude-sonnet-4-6"].variants.high.reasoningEffort,
      "high",
    );

    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.deepEqual(auth.hallpass, { type: "api", key: SAMPLE_PAYLOAD.token });
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
    }
  }));

test("copilot adapter writes single-quoted 0600 copilot.env and idempotent shell profile block", () =>
  withTempHome((home) => {
    configureAgent("copilot", SAMPLE_PAYLOAD, { homeDir: home, shell: "/bin/zsh" });
    configureAgent("copilot", SAMPLE_PAYLOAD, { homeDir: home, shell: "/bin/zsh" });
    const zshrc = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
    assert.equal((zshrc.match(/# >>> hallpass >>>/g) || []).length, 1);

    const envFile = path.join(home, ".config", "hallpass", "copilot.env");
    const envContent = fs.readFileSync(envFile, "utf8");
    assert.match(envContent, /COPILOT_OFFLINE='true'/);
    assert.match(envContent, /COPILOT_PROVIDER_BASE_URL='https:\/\/api\.hallpassai\.com\/v1'/);
  }));

test("parseArgs rejects missing flag values and --dry-run does not claim pairing code on server", async () => {
  assert.throws(() => parseArgs(["--origin", "--dry-run", "HP-ABCD-2345"]), /Missing value/);

  let serverHit = false;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "hp-dry-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  const server = http.createServer((_req, res) => {
    serverHit = true;
    res.statusCode = 500;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const code = await cliMain([
      "HPL-ABCD-2345",
      "--agent",
      "claude-code",
      "--origin",
      base,
      "--dry-run",
    ]);
    assert.equal(code, 0);
    assert.equal(serverHit, false, "--dry-run must never consume server pairing code");
  } finally {
    process.env.HOME = prevHome;
    await new Promise((r) => server.close(r));
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("end-to-end CLI claims pairing code over HTTP, configures tool, verifies /v1/models, and reports configured status", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-cli-e2e-"));
  const prevCfg = process.env.HALLPASS_CONFIG_DIR;
  const prevDisableKc = process.env.HALLPASS_DISABLE_KEYCHAIN;
  const prevHome = process.env.HOME;
  process.env.HALLPASS_CONFIG_DIR = path.join(dir, ".config", "hallpass");
  process.env.HALLPASS_DISABLE_KEYCHAIN = "1";
  process.env.HOME = dir;

  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/core/pair/claim") {
      res.end(
        JSON.stringify({
          operationId: "op_1",
          harness: "claude-code",
          model: "claude-sonnet-4-6",
          token: SAMPLE_PAYLOAD.token,
          progressToken: "hp_pair_" + "a".repeat(43),
          apiBase: `http://127.0.0.1:${server.address().port}/v1`,
          models: SAMPLE_PAYLOAD.models,
        }),
      );
    } else if (req.url === "/v1/models") {
      res.end(JSON.stringify({ object: "list", data: [{ id: "claude-sonnet-4-6" }] }));
    } else if (req.url === "/api/core/pair/status") {
      res.end(JSON.stringify({ ok: true, phase: body.phase }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const exitCode = await cliMain(["HPL-ABCD-2345", "--origin", base]);
    assert.equal(exitCode, 0);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, "/api/core/pair/claim");
    assert.equal(calls[0].body.code, "HPL-ABCD-2345");
    assert.match(calls[0].body.meta.anonymousId, /^hp_cli_[a-f0-9]{32}$/);
    assert.equal(calls[0].body.meta.platform, process.platform);
    assert.equal(calls[1].url, "/v1/models");
    assert.equal(calls[1].auth, `Bearer ${SAMPLE_PAYLOAD.token}`);
    assert.equal(calls[2].url, "/api/core/pair/status");
    assert.equal(calls[2].body.phase, "configured");
    assert.deepEqual(calls[2].body.meta.configuredHarnesses, ["claude-code"]);
    assert.equal(calls[2].body.meta.gatewayVerified, true);

    // Test doctor, models, use <model>, and uninstall (server key revoke + full directory purge)
    let revokedAuth = null;
    server.removeAllListeners("request");
    server.on("request", async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models") {
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "claude-sonnet-4-6" }, { id: "claude-opus-5.5" }, { id: "gpt-5.4" }],
          }),
        );
      } else if (req.url === "/api/core/catalog") {
        res.end(
          JSON.stringify({
            models: [
              {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                provider: "Anthropic",
                protocols: ["messages", "chat/completions"],
                contextLength: 200000,
                reasoning: { supported: true, levels: ["low", "medium", "high", "max"] },
              },
              {
                id: "claude-opus-5.5",
                name: "Claude Opus 5.5",
                provider: "Anthropic",
                protocols: ["messages", "chat/completions"],
                contextLength: 1000000,
                reasoning: { supported: true, levels: ["low", "medium", "high", "max"] },
              },
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "OpenAI",
                protocols: ["responses", "chat/completions"],
                contextLength: 256000,
                reasoning: { supported: true, levels: ["low", "medium", "high"] },
              },
            ],
          }),
        );
      } else if (req.url?.startsWith("/api/core/cli/usage")) {
        res.end(
          JSON.stringify({
            ok: true,
            account: {
              restricted: false,
              debtMicros: "0",
              availableMicros: "5761466",
              heldMicros: "0",
              completedRequests: 2,
              pendingRequests: 0,
              totalCostMicros: "238534",
              inputTokens: "63512",
              cachedInputTokens: "31200",
              cacheWriteTokens: "32100",
              outputTokens: "1205",
            },
            key: {
              id: "key_1",
              prefix: SAMPLE_PAYLOAD.token.slice(0, 15),
              label: "Claude Code",
              harness: "claude-code",
              completedRequests: 2,
              pendingRequests: 0,
              totalCostMicros: "238534",
              inputTokens: "63512",
              cachedInputTokens: "31200",
              cacheWriteTokens: "32100",
              outputTokens: "1205",
            },
            recentRequests: [
              {
                id: "req_1",
                model: "claude-sonnet-4-6",
                protocol: "messages",
                harness: "claude-code",
                sameKey: true,
                status: "completed",
                costMicros: "71299",
                usage: {
                  input: 32500,
                  cachedInput: 31200,
                  cacheWriteInput: 1250,
                  output: 620,
                },
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        );
      } else if (req.url === "/api/core/cli/revoke") {
        revokedAuth = req.headers.authorization;
        res.end(JSON.stringify({ ok: true, revoked: true }));
      } else if (req.url === "/api/core/cli/event") {
        res.end(JSON.stringify({ ok: true, recorded: true }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });

    assert.equal(await cliMain(["doctor", "--origin", base]), 0);
    assert.equal(await cliMain(["status", "--origin", base]), 0);
    assert.equal(await cliMain(["usage", "--origin", base]), 0);
    assert.equal(await cliMain(["usage", "--json", "--origin", base]), 0);
    assert.equal(
      await cliMain(["models", "--provider", "Anthropic", "--search", "opus 5.5", "--origin", base]),
      0,
    );
    assert.equal(
      await cliMain(["use", "claude-opus-5.5", "--reasoning", "high", "--origin", base]),
      0,
    );
    const updatedClaude = JSON.parse(
      fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"),
    );
    assert.equal(updatedClaude.env.ANTHROPIC_MODEL, "claude-opus-5.5");
    assert.equal(updatedClaude.effortLevel, "high");
    assert.equal(updatedClaude.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);

    // Resetting `--reasoning auto` clears effortLevel even when user keys exist
    assert.equal(
      await cliMain(["use", "--reasoning", "auto", "--origin", base]),
      0,
    );
    const resetClaude = JSON.parse(
      fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"),
    );
    assert.equal(resetClaude.effortLevel, undefined);

    assert.equal(await cliMain(["uninstall", "--origin", base]), 0);
    assert.equal(revokedAuth, `Bearer ${SAMPLE_PAYLOAD.token}`);
    assert.equal(
      fs.existsSync(path.join(dir, ".config", "hallpass")),
      false,
      "~/.config/hallpass directory must be purged on full uninstall",
    );
    assert.equal(
      fs.existsSync(path.join(dir, ".claude", "settings.json")),
      false,
    );
  } finally {
    process.env.HOME = prevHome;
    if (prevCfg === undefined) delete process.env.HALLPASS_CONFIG_DIR;
    else process.env.HALLPASS_CONFIG_DIR = prevCfg;
    if (prevDisableKc === undefined) delete process.env.HALLPASS_DISABLE_KEYCHAIN;
    else process.env.HALLPASS_DISABLE_KEYCHAIN = prevDisableKc;
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("packed npm tarball extracts cleanly and runs real CLI subprocess across all harnesses", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hp-pack-test-"));
  const home = path.join(work, "home");
  const fakeBin = path.join(work, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "copilot"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/core/pair/claim") {
      res.end(
        JSON.stringify({
          operationId: "op_all",
          harness: "all",
          model: "claude-sonnet-4-6",
          token: SAMPLE_PAYLOAD.token,
          progressToken: "hp_pair_" + "b".repeat(43),
          apiBase: `http://127.0.0.1:${server.address().port}/v1`,
          models: SAMPLE_PAYLOAD.models,
        }),
      );
    } else if (req.url === "/v1/models") {
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "claude-sonnet-4-6" }, { id: "gpt-5.4" }],
        }),
      );
    } else if (req.url === "/api/core/pair/status") {
      res.end(JSON.stringify({ ok: true, phase: body.phase }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const pkgRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const { NODE_TEST_CONTEXT: _ntc2, ...cleanEnv } = process.env;
    const packOut = spawnSync("npm", ["pack", "--pack-destination", work], {
      cwd: pkgRoot,
      env: cleanEnv,
      encoding: "utf8",
    });
    assert.equal(packOut.status, 0, packOut.stderr);
    const tgz = path.join(work, packOut.stdout.trim().split(/\r?\n/).pop());
    const extractDir = path.join(work, "extracted");
    fs.mkdirSync(extractDir);
    assert.equal(
      spawnSync("tar", ["-xzf", tgz, "-C", extractDir], { encoding: "utf8" }).status,
      0,
    );

    const binPath = path.join(extractDir, "package", "bin", "cli.js");
    const env = {
      ...cleanEnv,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      SHELL: "/bin/zsh",
      HALLPASS_CONFIG_DIR: path.join(home, ".config", "hallpass"),
      HALLPASS_DISABLE_KEYCHAIN: "1",
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
    };
    const base = `http://127.0.0.1:${server.address().port}`;
    await execFileAsync(
      process.execPath,
      [binPath, "HPL-ABCD-2345", "--agent", "all", "--origin", base],
      { env },
    );
    assert.ok(fs.existsSync(path.join(home, ".claude", "settings.json")));
    assert.ok(fs.existsSync(path.join(home, ".codex", "config.toml")));
    assert.ok(fs.existsSync(path.join(home, ".config", "opencode", "opencode.json")));
    assert.ok(fs.existsSync(path.join(home, ".config", "hallpass", "copilot.env")));

    await execFileAsync(process.execPath, [binPath, "status"], { env });
    await execFileAsync(process.execPath, [binPath, "undo"], { env });
    assert.equal(
      fs.existsSync(path.join(home, ".local", "share", "opencode", "auth.json")),
      false,
    );
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("security & multi-harness regressions: blocks foreign --origin token exfiltration, rejects unknown flags, resets effort cleanly, and isolates native models", async () => {
  // 1. Unknown CLI flags must throw instead of silently becoming model IDs
  assert.throws(() => parseArgs(["use", "--resoning", "high"]), /Unknown option/);
  assert.deepEqual(
    parseArgs(["use", "-m", "gpt-5.4", "--reasoning=high"]).modelArg,
    "gpt-5.4",
  );

  // 2. Foreign --origin must never exfiltrate stored Bearer token
  assert.throws(
    () =>
      originFromApiBase(
        "https://api.hallpassai.com/v1",
        "https://attacker.example",
      ),
    /Untrusted apiBase host/,
  );
  let leaked = false;
  await revokeServerToken(
    {
      origin: "https://attacker.example",
      apiBase: "https://api.hallpassai.com/v1",
      token: SAMPLE_PAYLOAD.token,
    },
    {
      fetcher: async () => {
        leaked = true;
        return { ok: true, json: async () => ({ revoked: true }) };
      },
    },
  );
  await sendCliEvent(
    "cli_status",
    {
      origin: "https://attacker.example",
      apiBase: "https://api.hallpassai.com/v1",
      token: SAMPLE_PAYLOAD.token,
    },
    {
      fetcher: async () => {
        leaked = true;
        return { ok: true };
      },
    },
  );
  assert.equal(leaked, false, "foreign --origin must never receive stored Bearer token");

  // 3. Claude settings with user permissions clears effortLevel on auto reset, and Codex config.toml omits deprecated [profiles.*]
  withTempHome((home) => {
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2),
    );
    configureAgent("claude-code", SAMPLE_PAYLOAD, {
      homeDir: home,
      reasoningEffort: "high",
    });
    assert.equal(
      JSON.parse(fs.readFileSync(settingsPath, "utf8")).effortLevel,
      "high",
    );
    switchAgentModel("claude-code", "claude-sonnet-4-6", {
      homeDir: home,
      reasoningEffort: "auto",
      catalogModels: SAMPLE_PAYLOAD.models,
    });
    const afterReset = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(afterReset.effortLevel, undefined);
    assert.deepEqual(afterReset.permissions, { allow: ["Read"] });

    // Codex upsertCodexToml removes model_reasoning_effort without overrunning [mcp_servers.*] and omits legacy [profiles.*]
    const tomlWithReasoning = upsertCodexToml(
      '[mcp_servers.local]\nmodel = "keep-inside-section"\n',
      {
        model: "gpt-5.4",
        apiBase: "https://api.hallpassai.com/v1",
        nodePath: process.execPath,
        helperPath: "/tmp/read-key.mjs",
        reasoningEffort: "high",
      },
    );
    assert.match(tomlWithReasoning, /model_reasoning_effort = "high"/);
    assert.ok(!tomlWithReasoning.includes("[profiles."), "Codex 0.170+ forbids legacy [profiles.*]");
    const tomlCleared = upsertCodexToml(tomlWithReasoning, {
      model: "gpt-5.4",
      apiBase: "https://api.hallpassai.com/v1",
      nodePath: process.execPath,
      helperPath: "/tmp/read-key.mjs",
      reasoningEffort: null,
    });
    assert.ok(!tomlCleared.includes("model_reasoning_effort"));
    assert.match(tomlCleared, /\[mcp_servers\.local\]\nmodel = "keep-inside-section"/);
  });
});

test("coexist mode keeps existing logins & dotfiles untouched across claude-code, codex, opencode, and copilot, plus fish shell RC", () =>
  withTempHome((home) => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth_1" } }),
    );
    const claudeSettings = path.join(home, ".claude", "settings.json");
    fs.writeFileSync(
      claudeSettings,
      JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2),
    );

    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "chatgpt_1" } }),
    );
    const codexToml = path.join(home, ".codex", "config.toml");
    fs.writeFileSync(codexToml, 'model = "o3"\n');

    const ocDir = path.join(home, ".config", "opencode");
    fs.mkdirSync(ocDir, { recursive: true });
    const ocJson = path.join(ocDir, "opencode.json");
    fs.writeFileSync(
      ocJson,
      JSON.stringify({ model: "anthropic/claude-sonnet-4-6" }, null, 2),
    );
    const zshrc = path.join(home, ".zshrc");
    fs.writeFileSync(zshrc, 'export PATH="/usr/local/bin:$PATH"\n');

    assert.equal(detectExistingSubscription("claude-code", home).detected, true);
    assert.equal(detectExistingSubscription("codex", home).detected, true);

    configureAgent("claude-code", SAMPLE_PAYLOAD, { homeDir: home, mode: "coexist" });
    configureAgent("codex", SAMPLE_PAYLOAD, { homeDir: home, mode: "coexist" });
    configureAgent("opencode", SAMPLE_PAYLOAD, { homeDir: home, mode: "coexist" });
    configureAgent("copilot", SAMPLE_PAYLOAD, {
      homeDir: home,
      shell: "/bin/zsh",
      mode: "coexist",
    });

    // Global defaults remain untouched
    const afterClaude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    assert.equal(afterClaude.env, undefined);
    assert.deepEqual(afterClaude.permissions, { allow: ["Read"] });
    assert.ok(fs.existsSync(path.join(home, ".config", "hallpass", "claude-settings.json")));
    assert.ok(fs.existsSync(path.join(home, ".config", "hallpass", "bin", "claude-hp")));
    assert.equal(inspectAgentConfig("claude-code", { homeDir: home }).ok, true);

    const afterCodex = fs.readFileSync(codexToml, "utf8");
    assert.match(afterCodex, /^model = "o3"/m);
    assert.doesNotMatch(afterCodex, /^model_provider = "hallpass"/m);
    assert.match(afterCodex, /\[model_providers\.hallpass\]/);
    assert.ok(fs.existsSync(path.join(home, ".codex", "hallpass.config.toml")));
    assert.ok(fs.existsSync(path.join(home, ".config", "hallpass", "bin", "codex-hp")));
    assert.equal(inspectAgentConfig("codex", { homeDir: home }).ok, true);

    const afterOc = JSON.parse(fs.readFileSync(ocJson, "utf8"));
    assert.equal(afterOc.model, "anthropic/claude-sonnet-4-6");
    assert.ok(afterOc.provider.hallpass.models["claude-sonnet-4-6"]);
    assert.equal(inspectAgentConfig("opencode", { homeDir: home }).ok, true);

    assert.doesNotMatch(fs.readFileSync(zshrc, "utf8"), /hallpass/);
    assert.ok(fs.existsSync(path.join(home, ".config", "hallpass", "bin", "copilot-hp")));
    assert.equal(inspectAgentConfig("copilot", { homeDir: home, shell: "/bin/zsh" }).ok, true);

    pauseAgent("codex", { homeDir: home, codexSubscription: true });
    assert.match(fs.readFileSync(codexToml, "utf8"), /requires_openai_auth = true/);
    const coexistProfile = fs.readFileSync(path.join(home, ".codex", "hallpass.config.toml"), "utf8");
    assert.match(coexistProfile, /requires_openai_auth = false/);
    assert.match(coexistProfile, /base_url = "https:\/\/api\.hallpassai\.com\/v1"/);
    assert.match(coexistProfile, /\[model_providers\.hallpass\.auth\]/);

    undoAgent("all", { homeDir: home, shell: "/bin/zsh", fullCleanup: true });
    assert.equal(fs.existsSync(path.join(home, ".config", "hallpass")), false);
    assert.equal(fs.existsSync(path.join(home, ".codex", "hallpass.config.toml")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeSettings, "utf8")), {
      permissions: { allow: ["Read"] },
    });

    // Fish shell default mode writes valid fish syntax to ~/.config/fish/config.fish
    configureAgent("copilot", SAMPLE_PAYLOAD, {
      homeDir: home,
      shell: "/opt/homebrew/bin/fish",
      mode: "default",
    });
    const fishCfg = fs.readFileSync(
      path.join(home, ".config", "fish", "config.fish"),
      "utf8",
    );
    assert.match(fishCfg, /test -f '.*copilot\.fish'; and source '.*copilot\.fish'/);
    undoAgent("copilot", { homeDir: home, shell: "/opt/homebrew/bin/fish" });
    assert.equal(
      fs.existsSync(path.join(home, ".config", "fish", "config.fish")),
      false,
    );
  }));

test("surgical previous-state restoration preserves post-install user edits across add, pause, resume, and undo", () =>
  withTempHome((home) => {
    const claudeSettings = path.join(home, ".claude", "settings.json");
    const codexToml = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.mkdirSync(path.dirname(codexToml), { recursive: true });
    fs.writeFileSync(
      claudeSettings,
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2),
    );
    fs.writeFileSync(codexToml, 'model = "o3"\n');

    configureAgent("claude-code", SAMPLE_PAYLOAD, { homeDir: home, reasoningEffort: "high" });
    configureAgent("codex", SAMPLE_PAYLOAD, { homeDir: home, reasoningEffort: "medium" });

    // Simulate user adding hooks & MCP servers days AFTER HallPass was installed
    const midClaude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    midClaude.hooks = { PreToolUse: ["npm run lint"] };
    fs.writeFileSync(claudeSettings, JSON.stringify(midClaude, null, 2));
    fs.appendFileSync(codexToml, '\n[mcp_servers.post_install]\ncommand = "node"\n');

    // Add a non-Claude model to Claude Code modelPicker
    addModelToAgent("claude-code", "deepseek-v4.1-flash", {
      homeDir: home,
      catalogModels: [
        ...SAMPLE_PAYLOAD.models,
        {
          id: "deepseek-v4.1-flash",
          name: "DeepSeek V4.1 Flash",
          provider: "DeepSeek",
          protocols: ["messages", "chat/completions"],
        },
      ],
    });
    const withAdded = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    const dsEntry = withAdded.modelPicker.options.find(
      (o) => o.model === "deepseek-v4.1-flash",
    );
    assert.equal(dsEntry.behavesAs, "claude-sonnet-4-6");

    // Pause -> restores native defaults while preserving post-install hooks & MCP servers
    pauseAgent("all", { homeDir: home });
    assert.equal(inspectAgentConfig("claude-code", { homeDir: home }).paused, true);
    assert.equal(inspectAgentConfig("codex", { homeDir: home }).paused, true);
    const pausedClaude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    assert.equal(pausedClaude.env, undefined);
    assert.deepEqual(pausedClaude.hooks, { PreToolUse: ["npm run lint"] });
    const pausedCodex = fs.readFileSync(codexToml, "utf8");
    assert.match(pausedCodex, /^model = "o3"/m);
    assert.match(pausedCodex, /\[mcp_servers\.post_install\]/);

    const launch = buildEphemeralLaunchSpec("codex", {
      token: SAMPLE_PAYLOAD.token,
      apiBase: SAMPLE_PAYLOAD.apiBase,
      model: "gpt-5.4",
      extraArgs: ["resume", "saved-thread"],
      homeDir: home,
    });
    assert.match(launch.args[1], /auth=\{command=/);
    assert.doesNotMatch(launch.args[1], /env_key=/);
    assert.equal(launch.env.HALLPASS_API_KEY, SAMPLE_PAYLOAD.token);
    assert.deepEqual(launch.args.slice(-2), ["resume", "saved-thread"]);
    assert.equal(fs.readFileSync(codexToml, "utf8"), pausedCodex);

    pauseAgent("codex", { homeDir: home, codexSubscription: true });
    const subscriptionConfig = fs.readFileSync(codexToml, "utf8");
    assert.match(subscriptionConfig, /^model = "o3"/m);
    assert.match(subscriptionConfig, /base_url = "https:\/\/chatgpt\.com\/backend-api\/codex"/);
    assert.match(subscriptionConfig, /requires_openai_auth = true/);
    assert.doesNotMatch(subscriptionConfig, /model_providers\.hallpass\.auth/);
    assert.match(subscriptionConfig, /\[mcp_servers\.post_install\]/);
    pauseAgent("codex", { homeDir: home });
    assert.equal(fs.readFileSync(codexToml, "utf8"), subscriptionConfig);
    const hallpassLaunch = buildEphemeralLaunchSpec("codex", {
      token: SAMPLE_PAYLOAD.token,
      apiBase: SAMPLE_PAYLOAD.apiBase,
      model: "gpt-5.4",
      homeDir: home,
    });
    assert.match(hallpassLaunch.args[1], /requires_openai_auth=false,env_key="HALLPASS_API_KEY"/);

    // Resume -> re-applies HallPass while keeping post-install hooks & MCP servers
    resumeAgent("all", { homeDir: home, catalogModels: SAMPLE_PAYLOAD.models });
    assert.equal(inspectAgentConfig("claude-code", { homeDir: home }).paused, undefined);
    assert.match(fs.readFileSync(codexToml, "utf8"), /\[model_providers\.hallpass\.auth\]/);
    assert.equal(
      JSON.parse(fs.readFileSync(claudeSettings, "utf8")).env.ANTHROPIC_MODEL,
      "claude-sonnet-4-6",
    );

    // Undo -> surgically removes HallPass without clobbering post-install hooks or MCP servers!
    undoAgent("all", { homeDir: home });
    const finalClaude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    assert.equal(finalClaude.env, undefined);
    assert.equal(finalClaude.modelPicker, undefined);
    assert.deepEqual(finalClaude.permissions, { allow: ["Bash(ls)"] });
    assert.deepEqual(finalClaude.hooks, { PreToolUse: ["npm run lint"] });

    const finalCodex = fs.readFileSync(codexToml, "utf8");
    assert.match(finalCodex, /^model = "o3"/m);
    assert.doesNotMatch(finalCodex, /hallpass/);
    assert.match(finalCodex, /\[mcp_servers\.post_install\]/);
  }));

test("interactive subscription guard, per-harness all-mode partial uninstall, agent aliases, and $0.00 status warning", async () => {
  assert.equal(normalizeAgentName("claude"), "claude-code");
  assert.equal(parseArgs(["run", "claude", "--", "-p", "Hi"]).agent, "claude-code");
  assert.deepEqual(parseArgs(["run", "claude", "--", "-p", "Hi"]).passThroughArgs, [
    "-p",
    "Hi",
  ]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-guard-test-"));
  const prevCfg = process.env.HALLPASS_CONFIG_DIR;
  const prevDisableKc = process.env.HALLPASS_DISABLE_KEYCHAIN;
  const prevHome = process.env.HOME;
  process.env.HALLPASS_CONFIG_DIR = path.join(dir, ".config", "hallpass");
  process.env.HALLPASS_DISABLE_KEYCHAIN = "1";
  process.env.HOME = dir;

  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "oauth_live" } }),
  );
  fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });

  const tokClaude = "hp_live_" + "c".repeat(43);
  const tokCodex = "hp_live_" + "x".repeat(43);
  const revokedTokens = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/core/pair/claim") {
      res.end(
        JSON.stringify({
          operationId: "op_guard",
          harness: body.harnesses ? "all" : "claude-code",
          model: "claude-sonnet-4-6",
          token: tokClaude,
          tokensByHarness: {
            "claude-code": tokClaude,
            codex: tokCodex,
          },
          progressToken: "hp_pair_" + "c".repeat(43),
          apiBase: `http://127.0.0.1:${server.address().port}/v1`,
          models: SAMPLE_PAYLOAD.models,
        }),
      );
    } else if (req.url === "/v1/models") {
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "claude-sonnet-4-6" }, { id: "gpt-5.4" }],
        }),
      );
    } else if (req.url === "/api/core/pair/status") {
      res.end(JSON.stringify({ ok: true, phase: body.phase }));
    } else if (req.url === "/api/core/cli/revoke") {
      revokedTokens.push(req.headers.authorization);
      res.end(JSON.stringify({ ok: true, revoked: true }));
    } else if (req.url?.startsWith("/api/core/cli/usage")) {
      res.end(
        JSON.stringify({
          ok: true,
          account: {
            restricted: false,
            debtMicros: "0",
            availableMicros: "0",
            heldMicros: "0",
            completedRequests: 5,
            totalCostMicros: "3000000",
          },
        }),
      );
    } else if (req.url === "/api/core/cli/event") {
      res.end(JSON.stringify({ ok: true, recorded: true }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const input = new PassThrough();
    const output = new PassThrough();
    // Press Enter on subscription guard -> selects [1] coexist!
    input.end("\n");
    const exit = await cliMain(
      ["HPL-ABCD-2345", "--agent", "all", "--no-launch", "--origin", base],
      { interactive: true, input, output },
    );
    assert.equal(exit, 0);
    assert.equal(
      fs.existsSync(path.join(dir, ".claude", "settings.json")),
      false,
      "interactive subscription guard default [1] must keep ~/.claude/settings.json untouched",
    );
    assert.ok(
      fs.existsSync(path.join(dir, ".config", "hallpass", "claude-settings.json")),
    );

    // Partial uninstall of codex revokes ONLY codex's dedicated token, leaving claude-code intact!
    assert.equal(
      await cliMain(["uninstall", "--agent", "codex", "--origin", base]),
      0,
    );
    assert.deepEqual(revokedTokens, [`Bearer ${tokCodex}`]);

    // Status with $0.00 balance succeeds and reports JSON ledger with availableMicros: "0"
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      assert.equal(await cliMain(["status", "--origin", base]), 0);
    } finally {
      console.log = origLog;
    }
    assert.ok(logs.some((l) => l.includes("Out of credits")));
  } finally {
    process.env.HOME = prevHome;
    if (prevCfg === undefined) delete process.env.HALLPASS_CONFIG_DIR;
    else process.env.HALLPASS_CONFIG_DIR = prevCfg;
    if (prevDisableKc === undefined) delete process.env.HALLPASS_DISABLE_KEYCHAIN;
    else process.env.HALLPASS_DISABLE_KEYCHAIN = prevDisableKc;
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("auth browser OAuth callback verifies state, rejects bad state, claims code, and keeps picker registration separate from changing the Codex default", async () => {
  assert.equal(parseArgs(["auth"]).command, "auth");
  assert.equal(parseArgs(["login"]).command, "auth");
  assert.equal(parseArgs(["auth", "HPL-ABCD-2345"]).code, "HPL-ABCD-2345");
  assert.equal(parseArgs(["auth", "--no-browser"]).noBrowser, true);
  assert.equal(parseArgs(["add", "deepseek-v4.1-flash", "--harness", "codex"]).agent, "codex");
  assert.equal(parseArgs(["add", "deepseek-v4.1-flash", "--harness=claude"]).agent, "claude-code");

  // Non-interactive auth without code fails fast instead of hanging
  const failFast = await cliMain(["auth"], { interactive: false });
  assert.equal(failFast, 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-oauth-cli-"));
  const prevCfg = process.env.HALLPASS_CONFIG_DIR;
  const prevDisableKc = process.env.HALLPASS_DISABLE_KEYCHAIN;
  const prevHome = process.env.HOME;
  process.env.HALLPASS_CONFIG_DIR = path.join(dir, ".config", "hallpass");
  process.env.HALLPASS_DISABLE_KEYCHAIN = "1";
  process.env.HOME = dir;

  const catalogWithDeepSeek = [
    ...SAMPLE_PAYLOAD.models,
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      provider: "DeepSeek",
      protocols: ["messages", "responses", "chat/completions"],
    },
  ];
  const tok = "hp_live_" + "o".repeat(43);

  const server = http.createServer(async (req, res) => {
    for await (const _c of req) { /* drain */ }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/core/pair/claim") {
      res.end(
        JSON.stringify({
          operationId: "op_browser_auth",
          harness: "codex",
          model: "gpt-5.4",
          token: tok,
          progressToken: "hp_pair_" + "o".repeat(43),
          apiBase: `http://127.0.0.1:${server.address().port}/v1`,
          models: catalogWithDeepSeek,
        }),
      );
    } else if (req.url === "/api/core/catalog") {
      res.end(JSON.stringify({ models: catalogWithDeepSeek }));
    } else if (req.url === "/v1/models") {
      res.end(JSON.stringify({ object: "list", data: catalogWithDeepSeek.map((m) => ({ id: m.id })) }));
    } else if (req.url === "/api/core/pair/status" || req.url === "/api/core/cli/event") {
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    let openedUrl = null;
    let callbackFlow = null;
    const input = new PassThrough();
    const output = new PassThrough();
    const exit = await cliMain(
      ["auth", "--agent", "codex", "--no-launch", "--origin", base],
      {
        interactive: true,
        input,
        output,
        openBrowser: (urlStr) => {
          openedUrl = new URL(urlStr);
          const port = openedUrl.searchParams.get("cli_port");
          const state = openedUrl.searchParams.get("cli_state");
          callbackFlow = (async () => {
            const r1 = await fetch(
              `http://127.0.0.1:${port}/callback?code=HPL-ABCD-2345&state=wrong_state`,
            );
            assert.equal(r1.status, 400);
            await r1.text();
            const r2 = await fetch(
              `http://127.0.0.1:${port}/callback?code=HPL-ABCD-2345&state=${encodeURIComponent(state)}`,
            );
            assert.equal(r2.status, 200);
            await r2.text();
          })();
          return true;
        },
      },
    );
    await callbackFlow;
    assert.equal(exit, 0);
    assert.ok(openedUrl, "auth must invoke browser launch with cli_port and cli_state");
    assert.equal(openedUrl.searchParams.get("cli_agent"), "codex");

    const configPath = path.join(dir, ".codex", "config.toml");
    const savedConfig = fs.readFileSync(configPath, "utf8");
    assert.equal(await cliMain(["add", "deepseek-v4.1-flash", "--agent", "codex", "--origin", base]), 1);
    assert.equal(fs.readFileSync(configPath, "utf8"), savedConfig);
    assert.equal(await cliMain(["use", "deepseek-v4.1-flash", "--agent", "codex", "--origin", base]), 0);
    const codexToml = fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
    assert.match(codexToml, /model = "deepseek-v4\.1-flash"/);
  } finally {
    process.env.HOME = prevHome;
    if (prevCfg === undefined) delete process.env.HALLPASS_CONFIG_DIR;
    else process.env.HALLPASS_CONFIG_DIR = prevCfg;
    if (prevDisableKc === undefined) delete process.env.HALLPASS_DISABLE_KEYCHAIN;
    else process.env.HALLPASS_DISABLE_KEYCHAIN = prevDisableKc;
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("add without model opens filterable picker with top 5 popular models first, supports arrow cycling + typing + Esc", async () => {
  const catalog = [
    { id: "zeta-model", name: "Zeta 1", provider: "Zeta", protocols: ["messages", "responses", "chat/completions"] },
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", provider: "Moonshot AI", protocols: ["messages", "responses", "chat/completions"] },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "OpenAI", protocols: ["messages", "responses", "chat/completions"] },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", provider: "Anthropic", protocols: ["messages", "chat/completions"] },
    { id: "alpha-fast", name: "Alpha Fast", provider: "Alpha", protocols: ["messages", "responses", "chat/completions"] },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "DeepSeek", protocols: ["messages", "responses", "chat/completions"] },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "Anthropic", protocols: ["messages", "responses", "chat/completions"] },
    { id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "Google", protocols: ["messages", "chat/completions"] },
  ];

  // 1. Popular ordering puts top 5 popular models at top
  const ordered = orderModelsWithPopularFirst(catalog, 5);
  assert.deepEqual(
    ordered.slice(0, 5).map((m) => m.id),
    ["deepseek-v4.1-flash", "claude-opus-5.5", "claude-sonnet-5.5", "gpt-6.1-sol", "gemini-4-carbon"],
  );
  assert.equal(ordered[0].isPopular, true);
  assert.equal(ordered[4].isPopular, true);
  assert.equal(ordered[5].isPopular, false);

  // 2. Type-to-filter matches across id, name, and provider
  assert.deepEqual(
    filterModelsByQuery(ordered, "moonshot").map((m) => m.id),
    ["kimi-k3.1-pro"],
  );
  assert.deepEqual(
    filterModelsByQuery(ordered, "claude").map((m) => m.id),
    ["claude-opus-5.5", "claude-sonnet-5.5"],
  );

  // 3. Raw TTY mode: cycle down twice (index 0 -> 1 -> 2 = claude-sonnet-5.5), press Enter
  const rawIn = new PassThrough();
  const rawOut = new PassThrough();
  let rawModeState = false;
  rawIn.isTTY = true;
  rawOut.isTTY = true;
  rawIn.setRawMode = (v) => { rawModeState = Boolean(v); };
  const pickPromise = pickModelInteractive(catalog, { input: rawIn, output: rawOut });
  rawIn.write("\x1b[B"); // Down -> index 1 (claude-opus-5.5)
  rawIn.write("\x1b[B"); // Down -> index 2 (claude-sonnet-5.5)
  rawIn.write("\r"); // Enter
  assert.equal(await pickPromise, "claude-sonnet-5.5");
  assert.equal(rawModeState, false, "raw mode must be restored after pick");

  // 4. Raw TTY mode: type to filter ("kimi"), then Enter
  const rawIn2 = new PassThrough();
  const rawOut2 = new PassThrough();
  rawIn2.isTTY = true;
  rawOut2.isTTY = true;
  rawIn2.setRawMode = () => {};
  const pickPromise2 = pickModelInteractive(catalog, { input: rawIn2, output: rawOut2 });
  rawIn2.write("kimi");
  rawIn2.write("\r");
  assert.equal(await pickPromise2, "kimi-k3.1-pro");

  // 5. Raw TTY mode: Esc cancels cleanly
  const rawIn3 = new PassThrough();
  const rawOut3 = new PassThrough();
  rawIn3.isTTY = true;
  rawOut3.isTTY = true;
  rawIn3.setRawMode = () => {};
  const pickPromise3 = pickModelInteractive(catalog, { input: rawIn3, output: rawOut3 });
  rawIn3.write("\x1b");
  assert.equal(await pickPromise3, null);

  // 6. End-to-end `cliMain(["add"])` without model ID (piped interactive fallback + non-interactive fail-fast)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-add-pick-"));
  const prevCfg = process.env.HALLPASS_CONFIG_DIR;
  const prevDisableKc = process.env.HALLPASS_DISABLE_KEYCHAIN;
  const prevHome = process.env.HOME;
  process.env.HALLPASS_CONFIG_DIR = path.join(dir, ".config", "hallpass");
  process.env.HALLPASS_DISABLE_KEYCHAIN = "1";
  const priorXdg = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = path.join(dir, ".config");
  process.env.XDG_DATA_HOME = path.join(dir, ".local", "share");

  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/core/catalog") {
      res.end(JSON.stringify({ models: catalog }));
    } else if (req.url === "/api/core/cli/event") {
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    configureAgent(
      "opencode",
      {
        token: "hp_live_" + "p".repeat(43),
        apiBase: `${base}/v1`,
        model: "gpt-6.1-sol",
        models: catalog,
      },
      { homeDir: dir },
    );

    // Non-interactive without model fails fast
    assert.equal(
      await cliMain(["add", "--agent", "opencode", "--origin", base], { interactive: false }),
      1,
    );

    // Interactive without model: pick #1 (top popular compatible model = deepseek-v4.1-flash)
    const pipeIn = new PassThrough();
    const pipeOut = new PassThrough();
    pipeIn.end("1\n");
    const exit = await cliMain(["add", "--agent", "opencode", "--origin", base], {
      interactive: true,
      input: pipeIn,
      output: pipeOut,
    });
    assert.equal(exit, 0);
    const config = JSON.parse(fs.readFileSync(path.join(dir, ".config", "opencode", "opencode.json"), "utf8"));
    assert.ok(config.provider.hallpass.models["deepseek-v4.1-flash"]);
    assert.equal(config.model, "hallpass/gpt-6.1-sol");
  } finally {
    process.env.HOME = prevHome;
    for (const [name, value] of Object.entries(priorXdg)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (prevCfg === undefined) delete process.env.HALLPASS_CONFIG_DIR;
    else process.env.HALLPASS_CONFIG_DIR = prevCfg;
    if (prevDisableKc === undefined) delete process.env.HALLPASS_DISABLE_KEYCHAIN;
    else process.env.HALLPASS_DISABLE_KEYCHAIN = prevDisableKc;
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI safety regressions: positional uninstall/pause agent, Codex pause->uninstall no duplicate TOML keys, coexist Claude settings untouched, stripJsonc strings", () =>
  withTempHome((home) => {
    // 1. parseArgs parses positional harness name for uninstall/pause/resume (never silently widens to 'all')
    assert.equal(parseArgs(["uninstall", "codex"]).agent, "codex");
    assert.equal(parseArgs(["pause", "claude"]).agent, "claude-code");
    assert.equal(parseArgs(["pause", "codex", "--continue"]).continueThread, true);
    assert.equal(parseArgs(["resume", "opencode"]).agent, "opencode");

    // 2. stripJsonc preserves ',}' inside string literals
    const parsed = JSON.parse(stripJsonc('{"cmd": "echo a,}", // comment\n "ok": true,}'));
    assert.equal(parsed.cmd, "echo a,}");
    assert.equal(parsed.ok, true);

    // 3. Coexist claude-code + uninstall MUST NOT touch user's unrelated ~/.claude/settings.json
    const claudeSettings = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    const nativeSettings = {
      effortLevel: "high",
      env: { ANTHROPIC_BASE_URL: "https://custom.internal", ANTHROPIC_API_KEY: "sk-ant-user" },
    };
    fs.writeFileSync(claudeSettings, JSON.stringify(nativeSettings, null, 2));
    configureAgent("claude-code", SAMPLE_PAYLOAD, { homeDir: home, mode: "coexist" });
    pauseAgent("claude-code", { homeDir: home });
    undoAgent("claude-code", { homeDir: home, fullCleanup: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeSettings, "utf8")), nativeSettings);

    // 4. Codex pause -> pause -> uninstall never duplicates top-level model/provider TOML keys
    const codexToml = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(codexToml), { recursive: true });
    fs.writeFileSync(codexToml, 'model = "o3"\n\n[mcp_servers.local]\ncommand = "node"\n');
    configureAgent("codex", SAMPLE_PAYLOAD, { homeDir: home, mode: "default" });
    pauseAgent("codex", { homeDir: home });
    pauseAgent("codex", { homeDir: home });
    undoAgent("codex", { homeDir: home, fullCleanup: true });
    const finalToml = fs.readFileSync(codexToml, "utf8");
    assert.equal((finalToml.match(/^model = "o3"/gm) || []).length, 1);

    // 5. Cursor pause returns honest manual note instead of marking paused
    configureAgent("cursor", SAMPLE_PAYLOAD, { homeDir: home });
    const cursorPause = pauseAgent("cursor", { homeDir: home });
    assert.equal(cursorPause[0].manual, true);
    assert.equal(inspectAgentConfig("cursor", { homeDir: home }).paused, undefined);
  }));
