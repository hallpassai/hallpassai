import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import {
  configureAgent,
  undoAgent,
  normalizeCode,
  resolveOrigin,
  helperScriptPath,
} from "../src/index.js";
import { main as cliMain } from "../bin/cli.js";

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
    },
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      protocols: ["responses", "chat/completions"],
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
  assert.equal(normalizeCode("HP-0000-1111"), null); // excludes ambiguous 0/1/O/I
  assert.equal(normalizeCode("rm -rf /"), null);
  assert.equal(resolveOrigin("HP"), "https://app.hallpassai.com");
  assert.equal(resolveOrigin("HPD"), "https://dev.hallpassai.com");
});

test("claude-code adapter merges settings.json non-destructively, backs up, and undoes cleanly", () =>
  withTempHome((home) => {
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Bash(git status)"] }, env: { FOO: "bar" } }),
    );

    const res = configureAgent("claude-code", SAMPLE_PAYLOAD, { homeDir: home });
    assert.ok(res.backup?.endsWith(".hallpass.bak"));

    const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.permissions, { allow: ["Bash(git status)"] });
    assert.equal(written.env.FOO, "bar");
    assert.equal(written.env.ANTHROPIC_BASE_URL, "https://api.hallpassai.com");
    assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, SAMPLE_PAYLOAD.token);
    assert.equal(written.env.ANTHROPIC_API_KEY, "");
    assert.equal(written.env.ANTHROPIC_MODEL, "claude-sonnet-4-6");
    assert.equal(written.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8192");
    assert.equal(written.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");

    undoAgent("claude-code", { homeDir: home });
    const restored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(restored.env.FOO, "bar");
  }));

test("codex adapter writes responses wire_api and working credential helper command without plaintext key in config.toml", () =>
  withTempHome((home) => {
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    fs.writeFileSync(
      configPath,
      'model = "o3"\n\n[mcp_servers.demo]\ncommand = "npx"\n',
    );

    configureAgent("codex", SAMPLE_PAYLOAD, { homeDir: home });
    const toml = fs.readFileSync(configPath, "utf8");
    assert.ok(!toml.includes(SAMPLE_PAYLOAD.token), "config.toml must not contain raw API key");
    assert.match(toml, /model = "gpt-5\.4"/);
    assert.match(toml, /model_provider = "hallpass"/);
    assert.match(toml, /\[model_providers\.hallpass\]/);
    assert.match(toml, /wire_api = "responses"/);
    assert.match(toml, /\[model_providers\.hallpass\.auth\]/);
    assert.match(toml, /\[mcp_servers\.demo\]/);

    // Execute the generated credential helper script to verify stdout purity!
    const helper = helperScriptPath(home);
    const execRes = spawnSync(process.execPath, [helper, "codex"], {
      encoding: "utf8",
      env: { ...process.env, HALLPASS_DISABLE_KEYCHAIN: "1" },
    });
    assert.equal(execRes.status, 0);
    assert.equal(execRes.stdout, SAMPLE_PAYLOAD.token);
  }));

test("opencode adapter writes opencode.json provider and 0600 auth.json with type:api", () =>
  withTempHome((home) => {
    configureAgent("opencode", { ...SAMPLE_PAYLOAD, model: "gpt-5.4" }, { homeDir: home });
    const cfgPath = path.join(home, ".config", "opencode", "opencode.json");
    const authPath = path.join(home, ".local", "share", "opencode", "auth.json");

    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.model, "hallpass/gpt-5.4");
    assert.equal(cfg.provider.hallpass.npm, "@ai-sdk/openai-compatible");
    assert.equal(cfg.provider.hallpass.options.baseURL, "https://api.hallpassai.com/v1");
    assert.equal(cfg.provider.hallpass.models["gpt-5.4"].limit.output, 8192);

    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.deepEqual(auth.hallpass, { type: "api", key: SAMPLE_PAYLOAD.token });
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
    }
  }));

test("copilot adapter writes 0600 copilot.env and idempotent shell profile block", () =>
  withTempHome((home) => {
    configureAgent("copilot", SAMPLE_PAYLOAD, { homeDir: home, shell: "/bin/zsh" });
    configureAgent("copilot", SAMPLE_PAYLOAD, { homeDir: home, shell: "/bin/zsh" });
    const zshrc = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
    assert.equal((zshrc.match(/# >>> hallpass >>>/g) || []).length, 1);

    const envFile = path.join(home, ".config", "hallpass", "copilot.env");
    const envContent = fs.readFileSync(envFile, "utf8");
    assert.match(envContent, /COPILOT_OFFLINE="true"/);
    assert.match(envContent, /COPILOT_PROVIDER_BASE_URL="https:\/\/api\.hallpassai\.com\/v1"/);
  }));

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
    assert.equal(calls[1].url, "/v1/models");
    assert.equal(calls[1].auth, `Bearer ${SAMPLE_PAYLOAD.token}`);
    assert.equal(calls[2].url, "/api/core/pair/status");
    assert.equal(calls[2].body.phase, "configured");
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


test("packed npm tarball extracts cleanly and runs real CLI subprocess across all 5 harnesses", async () => {
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
      res.end(JSON.stringify({
        operationId: "op_all",
        harness: "all",
        model: "claude-sonnet-4-6",
        token: SAMPLE_PAYLOAD.token,
        progressToken: "hp_pair_" + "b".repeat(43),
        apiBase: `http://127.0.0.1:${server.address().port}/v1`,
        models: SAMPLE_PAYLOAD.models,
      }));
    } else if (req.url === "/v1/models") {
      res.end(JSON.stringify({ object: "list", data: [{ id: "claude-sonnet-4-6" }, { id: "gpt-5.4" }] }));
    } else if (req.url === "/api/core/pair/status") {
      res.end(JSON.stringify({ ok: true, phase: body.phase }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const pkgRoot = path.resolve(import.meta.dirname, "..");
    const packOut = spawnSync("npm", ["pack", "--pack-destination", work], { cwd: pkgRoot, encoding: "utf8" });
    assert.equal(packOut.status, 0, packOut.stderr);
    const tgz = path.join(work, packOut.stdout.trim().split(/\r?\n/).pop());
    const extractDir = path.join(work, "extracted");
    fs.mkdirSync(extractDir);
    assert.equal(spawnSync("tar", ["-xzf", tgz, "-C", extractDir], { encoding: "utf8" }).status, 0);

    const binPath = path.join(extractDir, "package", "bin", "cli.js");
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      SHELL: "/bin/zsh",
      HALLPASS_CONFIG_DIR: path.join(home, ".config", "hallpass"),
      HALLPASS_DISABLE_KEYCHAIN: "1",
    };
    const base = `http://127.0.0.1:${server.address().port}`;
    await execFileAsync(process.execPath, [binPath, "HPL-ABCD-2345", "--agent", "all", "--origin", base], { env });
    assert.ok(fs.existsSync(path.join(home, ".claude", "settings.json")));
    assert.ok(fs.existsSync(path.join(home, ".codex", "config.toml")));
    assert.ok(fs.existsSync(path.join(home, ".config", "opencode", "opencode.json")));
    assert.ok(fs.existsSync(path.join(home, ".config", "hallpass", "copilot.env")));

    await execFileAsync(process.execPath, [binPath, "status"], { env });
    await execFileAsync(process.execPath, [binPath, "undo"], { env });
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(work, { recursive: true, force: true });
  }
});
