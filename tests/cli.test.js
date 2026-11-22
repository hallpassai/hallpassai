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
  upsertCodexToml,
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
import { main as cliMain, parseArgs, normalizeAgentName } from "../bin/cli.js";

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
    assert.match(fishCfg, /test -f '.*copilot\.env'; and source '.*copilot\.env'/);
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

    // Resume -> re-applies HallPass while keeping post-install hooks & MCP servers
    resumeAgent("all", { homeDir: home, catalogModels: SAMPLE_PAYLOAD.models });
    assert.equal(inspectAgentConfig("claude-code", { homeDir: home }).paused, undefined);
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
      ["HPL-ABCD-2345", "--agent", "all", "--origin", base],
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
