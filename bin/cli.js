#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  SUPPORTED_AGENTS,
  VALID_REASONING_LEVELS,
  detectInstalledAgents,
  detectExistingSubscription,
  configureAgent,
  addModelToAgent,
  buildEphemeralLaunchSpec,
  resolveRealBinary,
  prepareCodexSubscriptionResume,
  pauseAgent,
  resumeAgent,
  undoAgent,
  inspectAgentConfig,
  switchAgentModel,
  copyToClipboard,
} from "../src/adapters.js";
import {
  normalizeCode,
  resolveOrigin,
  validateEndpointUrl,
  isValidModelId,
  claimCode,
  fetchLiveModels,
  fetchCatalogDetails,
  fetchCliUsage,
  verifyGatewayReachable,
  sendPairingStatus,
  revokeServerToken,
  sendCliEvent,
  buildCliMeta,
} from "../src/client.js";
import {
  readStoredCredentials,
  getAnonymousId,
  telemetryDisabled,
} from "../src/secrets.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const nativeFlags = require("../src/native-flags.json");
const nativeName = agent => agent === "claude-code" ? "claude" : agent;
const nativeRootOptions = new Map(Object.entries(nativeFlags).map(([name, entry]) =>
  [name, new Set(entry.commands[""].flatMap(decl => decl.match(/^--?[\w-]+(?:,?\s+--?[\w-]+)*/)[0].match(/--?[\w-]+/g)))]));

function nativeCommandPath(agent, words) {
  const name = nativeName(agent);
  if (!Object.hasOwn(nativeFlags, name)) return false;
  const inventory = nativeFlags[name];
  let key = "";
  for (const word of words) {
    if (!/^[\w-]+$/.test(word)) return false;
    key = key ? key + " " + word : word;
    if (Object.hasOwn(inventory.aliases, key)) key = inventory.aliases[key];
    if (!Object.hasOwn(inventory.commands, key) && !inventory.platforms?.[process.platform]?.[key]) return false;
  }
  return true;
}

function nativeDiscovery(agent, args) {
  if (!Object.hasOwn(nativeFlags, nativeName(agent)) || !args.length) return false;
  if (args.length === 1 && ["--version", agent === "codex" ? "-V" : "-v"].includes(args[0])) return true;
  if (["-h", "--help"].includes(args.at(-1))) return nativeCommandPath(agent, args.slice(0, -1));
  if (agent === "codex" && args[0] === "help") return nativeCommandPath(agent, args.slice(1));
  if (agent === "copilot" && args[0] === "help" && args.length <= 2) return true;
  return false;
}

const cleanLog = (s) => {
  const str = String(s ?? "");
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0x20 && code < 0x7f) || code >= 0xa0) out += str[i];
  }
  return out;
};
const green = (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);

const UNINSTALL_ALIASES = new Set([
  "uninstall",
  "cleanup",
  "clean",
  "disconnect",
  "remove",
]);

const isMain = (() => {
  try {
    return Boolean(
      process.argv[1] &&
        import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href,
    );
  } catch {
    return false;
  }
})();

export function normalizeAgentName(val) {
  if (!val) return val;
  const s = String(val).trim().toLowerCase();
  if (s === "claude" || s === "claudecode") return "claude-code";
  if (s === "github-copilot" || s === "gh-copilot") return "copilot";
  return s;
}

function isInteractiveTerminal({
  input = process.stdin,
  output = process.stdout,
  interactive,
} = {}) {
  if (typeof interactive === "boolean") return interactive;
  if (
    !isMain ||
    process.env.CI ||
    process.env.NODE_TEST_CONTEXT ||
    process.env.HALLPASS_NONINTERACTIVE === "1"
  ) {
    return false;
  }
  return Boolean(input?.isTTY && output?.isTTY);
}

function printHelp() {
  console.log(`${bold("hallpassai")} v${pkg.version} — Connect your coding tools to HallPass

${bold("Usage:")}
  npx hallpassai setup [HARNESS] [PAIRING-CODE] [--default | --coexist]
  npx hallpassai auth [PAIRING-CODE] [--harness <name>]
  npx hallpassai add [MODEL-ID] [--harness <name>]
  npx hallpassai models [--provider <name>] [--search <query>]
  npx hallpassai use [MODEL-ID] [-r <level>] [--harness <name>]
  npx hallpassai run [HARNESS] [MODEL-ID] [tool-args...]
  npx hallpassai pause | resume [--harness <name>]
  npx hallpassai pause codex --continue [--model <id>]
  npx hallpassai usage | status | doctor [--json]
  npx hallpassai uninstall [--harness <name>] [--keep-keys]

${bold("Options:")}
  --harness <name>       Target a specific tool (${SUPPORTED_AGENTS.join(", ")})
  -r, --reasoning <lvl>  Set reasoning depth (auto, none, minimal, low, medium, high, max, xhigh, ultra)
  -m, --model <id>       Choose an explicit model
  --provider <name>      Filter \`models\` list by provider (e.g. Anthropic, OpenAI, DeepSeek)
  --search <query>       Search \`models\` list by name or ID
  --no-browser           Print login URL without opening a browser (for SSH / remote shells)
  --launch / --no-launch Auto-launch (or skip prompt to launch) tool after auth
  --json                 Output structured JSON for \`usage\` / \`status\`
  --dry-run              Preview configuration changes without claiming code or writing files
  --keep-keys            Keep server API keys active during uninstall (local cleanup only)
  --continue            Pick a saved Codex thread to continue on your ChatGPT subscription
  --origin <url>         Override HallPass server origin
  -h, --help             Show help
  -v, --version          Show version

For run, put HallPass options before the harness. Native commands and flags
follow the harness and optional model. Use -- for an ambiguous positional.
`);
}

function runHarness(agent, command, args, env = process.env) {
  const launched = spawnSync(command, args, { stdio: "inherit", env });
  if (launched.error) {
    console.error(red(`Could not launch ${cleanLog(agent)}: ${cleanLog(launched.error.message)}`));
    return 1;
  }
  return launched.status ?? 1;
}

function formatMicrosUsd(micros, { exact = false } = {}) {
  const n = Number(micros || 0);
  if (!Number.isFinite(n)) return "$0.00";
  const usd = n / 1000000;
  if (exact || (usd > 0 && usd < 0.01)) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatCompactTokens(val) {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("en-US");
}

function printQuickControls(agent, _appliedModel) {
  if (agent === "cursor") return;
  const inToolSwitch =
    agent === "opencode" ? "`/models` (or `Ctrl+T` for reasoning)" : "`/model`";
  console.log(`  ${dim("in-session")} ${inToolSwitch} · \`npx hallpassai add --harness ${agent}\` (interactive picker) · \`npx hallpassai pause ${agent}\``);
}

// Older callers can put HallPass launch options between the harness and an explicit
// separator. Match that whole prefix so a native flag's values and literal -- survive.
const legacyRunOptions = new Set(["--origin", "--model", "-m", "--reasoning", "--effort", "-r"]);
function isLegacyRunPrefix(argv, start, separator, hasModel) {
  if (start >= separator) return false;
  for (let i = start; i < separator; i++) {
    const arg = argv[i];
    const [flag] = arg.split("=", 1);
    if (legacyRunOptions.has(flag)) {
      const value = arg.includes("=") ? arg.slice(flag.length + 1) : argv[++i];
      if (i >= separator || !value || value.startsWith("-")) return false;
      if (["-r", "--reasoning", "--effort"].includes(flag) && !VALID_REASONING_LEVELS.has(value.toLowerCase())) return false;
    } else if (!hasModel && isValidModelId(arg)) {
      hasModel = true;
    } else {
      return false;
    }
  }
  return true;
}

export function parseArgs(argv) {
  const out = {
    command: null,
    code: null,
    modelArg: null,
    reasoning: null,
    provider: null,
    search: null,
    agent: null,
    mode: null,
    launch: null,
    noBrowser: false,
    json: false,
    dryRun: false,
    keepKeys: false,
    continueThread: false,
    origin: null,
    passThroughArgs: [],
  };
  const separator = argv.indexOf("--");
  let legacyEnd = -1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.passThroughArgs = argv.slice(i + 1);
      break;
    }
    if (out.command === "run" && out.agent && i >= legacyEnd) {
      if (out.agent === "cursor" || nativeCommandPath(out.agent, [a])) {
        out.passThroughArgs = argv.slice(i);
        break;
      }
      if (!out.modelArg && isValidModelId(a) && a !== "help" && a !== "version") {
        out.modelArg = a;
        continue;
      }
      // An unambiguous HallPass option identifies the older spelling. A native
      // --model or -r followed by -- still belongs to the native command.
      if (isLegacyRunPrefix(argv, i, separator, Boolean(out.modelArg)) &&
          argv.slice(i, separator).some(word => {
            const flag = word.split("=", 1)[0];
            return legacyRunOptions.has(flag) && !nativeRootOptions.get(nativeName(out.agent))?.has(flag);
          })) {
        legacyEnd = separator;
      } else {
        out.passThroughArgs = argv.slice(i);
        break;
      }
    }
    if (a === "-h" || a === "--help" || a === "help") {
      out.command = "help";
      return out;
    }
    if (a === "-v" || a === "--version" || a === "version") {
      out.command = "version";
      return out;
    }
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--no-browser") {
      out.noBrowser = true;
      continue;
    }
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (a === "--keep-keys") {
      out.keepKeys = true;
      continue;
    }
    if (a === "--continue") {
      out.continueThread = true;
      continue;
    }
    if (a === "--coexist") {
      out.mode = "coexist";
      continue;
    }
    if (a === "--default") {
      out.mode = "default";
      continue;
    }
    if (a === "--launch") {
      out.launch = true;
      continue;
    }
    if (a === "--no-launch") {
      out.launch = false;
      continue;
    }
    if (a === "--mode") {
      const next = argv[++i];
      if (!next || !["default", "coexist"].includes(next.toLowerCase())) {
        throw new Error("Invalid value for --mode (expected default or coexist).");
      }
      out.mode = next.toLowerCase();
      continue;
    }
    if (a.startsWith("--mode=")) {
      const val = a.slice(a.indexOf("=") + 1).toLowerCase();
      if (!["default", "coexist"].includes(val)) {
        throw new Error("Invalid value for --mode (expected default or coexist).");
      }
      out.mode = val;
      continue;
    }
    if (a === "--harness" || a === "--agent") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${a}.`);
      }
      out.agent = normalizeAgentName(next);
      continue;
    }
    if (a.startsWith("--harness=") || a.startsWith("--agent=")) {
      out.agent = normalizeAgentName(a.slice(a.indexOf("=") + 1));
      if (!out.agent) throw new Error(`Missing value for ${a.split("=")[0]}.`);
      continue;
    }
    if (a === "-m" || a === "--model") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${a}.`);
      }
      out.modelArg = next;
      continue;
    }
    if (a.startsWith("--model=")) {
      out.modelArg = a.slice(a.indexOf("=") + 1);
      if (!out.modelArg) throw new Error("Missing value for --model.");
      continue;
    }
    if (a === "-r" || a === "--reasoning" || a === "--effort") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${a}.`);
      }
      out.reasoning = next.toLowerCase();
      continue;
    }
    if (a.startsWith("--reasoning=") || a.startsWith("--effort=")) {
      out.reasoning = a.slice(a.indexOf("=") + 1).toLowerCase();
      if (!out.reasoning) throw new Error("Missing value for --reasoning.");
      continue;
    }
    if (a === "--provider") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --provider.");
      }
      out.provider = next;
      continue;
    }
    if (a.startsWith("--provider=")) {
      out.provider = a.slice(a.indexOf("=") + 1);
      if (!out.provider) throw new Error("Missing value for --provider.");
      continue;
    }
    if (a === "--search") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --search.");
      }
      out.search = next;
      continue;
    }
    if (a.startsWith("--search=")) {
      out.search = a.slice(a.indexOf("=") + 1);
      if (!out.search) throw new Error("Missing value for --search.");
      continue;
    }
    if (a === "--origin") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --origin.");
      }
      out.origin = next;
      continue;
    }
    if (a.startsWith("--origin=")) {
      out.origin = a.slice(a.indexOf("=") + 1);
      if (!out.origin) throw new Error("Missing value for --origin.");
      continue;
    }
    if (a.startsWith("-")) {
      if (out.command === "run") {
        out.passThroughArgs = argv.slice(i);
        break;
      }
      throw new Error(`Unknown option: ${a}`);
    }
    if (!out.command) {
      if (UNINSTALL_ALIASES.has(a)) {
        out.command = "uninstall";
        continue;
      }
      if (
        [
          "setup",
          "auth",
          "login",
          "connect",
          "pair",
          "status",
          "usage",
          "balance",
          "credits",
          "doctor",
          "undo",
          "pause",
          "resume",
          "models",
          "use",
          "model",
          "add",
          "run",
          "launch",
        ].includes(a)
      ) {
        out.command =
          a === "login"
            ? "auth"
            : a === "model"
              ? "use"
              : a === "launch"
                ? "run"
                : a === "balance" || a === "credits"
                  ? "usage"
                  : a;
        continue;
      }
    }
    if (out.command === "setup") {
      const agent = normalizeAgentName(a);
      if (SUPPORTED_AGENTS.includes(agent) && !out.agent) out.agent = agent;
      else if (normalizeCode(a) && !out.code) out.code = a;
      else throw new Error(`Unexpected setup argument: ${cleanLog(a)}. Use hallpassai setup <tool> [PAIRING-CODE].`);
      continue;
    }
    if (
      ["run", "pause", "resume", "uninstall", "undo", "status", "doctor", "usage"].includes(
        out.command,
      ) &&
      !out.agent
    ) {
      const normalized = normalizeAgentName(a);
      if (normalized === "all" || SUPPORTED_AGENTS.includes(normalized)) {
        out.agent = normalized;
        continue;
      }
    }
    if ((out.command === "use" || out.command === "add" || out.command === "run") && !out.modelArg) {
      out.modelArg = a;
      continue;
    }
    if (out.command === "models") {
      out.search = out.search ? `${out.search} ${a}` : a;
      continue;
    }
    if (!out.code) out.code = a;
  }
  if (!out.command) out.command = out.code ? "connect" : "help";
  return out;
}

async function runCursorInteractive(
  values,
  { input = process.stdin, output = process.stdout, interactive } = {},
) {
  console.log(
    `\n${bold("Cursor setup (Cursor → Settings → Models):")}`,
  );
  const isTty = isInteractiveTerminal({ input, output, interactive });
  const copiedUrl = isTty ? copyToClipboard(values.baseUrl) : false;
  console.log(
    `  1. ${bold("Override OpenAI Base URL:")} ${cleanLog(values.baseUrl)}${copiedUrl ? ` ${green("(✓ copied to clipboard)")}` : ""}`,
  );
  console.log(
    `  2. ${bold("OpenAI API Key:")} ${cleanLog(values.apiKey.slice(0, 15))}•••••• ${dim("(save Base URL first before turning on the key)")}`,
  );
  console.log(`  3. ${bold("Add Custom Model:")} ${cleanLog(values.model)} ${dim("(turn off Auto mode in chat; skip built-in Verify)")}`);

  if (isTty && copiedUrl) {
    const rl = readline.createInterface({ input, output });
    try {
      await rl.question(
        dim("\n  Press Enter after saving Base URL to copy your API key… "),
      );
      if (copyToClipboard(values.apiKey))
        console.log(`  ${green("✓")} Copied API Key: ${cleanLog(values.apiKey.slice(0, 15))}••••••`);
      await rl.question(
        dim("  Press Enter after pasting API Key to copy the Model ID… "),
      );
      if (copyToClipboard(values.model))
        console.log(`  ${green("✓")} Copied Model ID: ${cleanLog(values.model)}`);
    } finally {
      rl.close();
    }
  }
}

function isRemoteOrHeadlessEnv(env = process.env) {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return true;
  }
  return false;
}

function openSystemBrowser(url) {
  try {
    const cmd =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd[0], cmd[1], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function safeEqualStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const AUTH_SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>HallPass CLI Authorized</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fafaf7; color: #242521; font: 500 15px/1.6 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }
    .card { max-width: 420px; padding: 32px; border-radius: 16px; background: #fff; border: 1px solid #dfe2d5; text-align: center; box-shadow: 0 12px 30px rgba(20,22,18,0.06); }
    .badge { display: inline-grid; place-items: center; width: 42px; height: 42px; border-radius: 12px; background: #e0f580; border: 1px solid #c2d766; color: #2a3816; font-size: 20px; font-weight: 700; margin-bottom: 14px; }
    h1 { margin: 0 0 8px; font-size: 20px; letter-spacing: -0.4px; }
    p { margin: 0; color: #555b4d; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">&#10003;</div>
    <h1>HallPass CLI authorized</h1>
    <p>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`;

export async function runBrowserAuthFlow({
  origin,
  agent = null,
  noBrowser = false,
  input = process.stdin,
  output = process.stdout,
  openBrowser = openSystemBrowser,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  const state = randomBytes(24).toString("base64url");
  const expectedPrefix = (() => {
    try {
      const h = new URL(origin).hostname.toLowerCase();
      if (h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]") return "HPL";
      if (h.startsWith("dev.")) return "HPD";
    } catch {}
    return "HP";
  })();
  let resolveDone;
  let rejectDone;
  const resultPromise = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let boundPort = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "close");
    const hostHdr = String(req.headers.host || "").toLowerCase();
    if (
      (boundPort &&
        hostHdr !== `127.0.0.1:${boundPort}` &&
        hostHdr !== `localhost:${boundPort}`) ||
      typeof req.url !== "string" ||
      req.url.length > 512
    ) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "GET" || reqUrl.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const gotState = reqUrl.searchParams.get("state") || "";
    const gotCode = normalizeCode(reqUrl.searchParams.get("code") || "");
    if (!safeEqualStrings(gotState, state) || !gotCode || gotCode.prefix !== expectedPrefix) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid or expired authorization callback.");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(AUTH_SUCCESS_HTML);
    resolveDone(gotCode.code);
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  boundPort = port;
  const authUrl = new URL("/start.html", origin);
  authUrl.searchParams.set("cli_port", String(port));
  authUrl.searchParams.set("cli_state", state);
  if (agent && agent !== "all") authUrl.searchParams.set("cli_agent", agent);
  authUrl.hash = "connect";

  const isDefaultOpener = openBrowser === openSystemBrowser;
  const headless = noBrowser || (isDefaultOpener && isRemoteOrHeadlessEnv());
  const opened = headless ? false : Boolean(openBrowser(authUrl.href));
  const verifyShort = state.slice(0, 6).toUpperCase();

  if (opened) {
    console.log(`${dim("→")} Opening browser to sign in to HallPass ${dim(`[verify: ${verifyShort}]`)}…`);
    console.log(`  ${dim("If it didn't open:")} ${authUrl.href}`);
  } else {
    console.log(`${bold("Sign in to HallPass in any browser:")} ${dim(`[verify: ${verifyShort}]`)}`);
    console.log(`  ${authUrl.href}`);
  }
  console.log(
    dim("  Waiting for browser callback (or paste a pairing code from Connect and press Enter)…"),
  );

  const rl = readline.createInterface({ input, output });
  let settled = false;
  const finish = (fn, val) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      rl.close();
    } catch {}
    server.close();
    server.closeAllConnections?.();
    fn(val);
  };

  rl.on("line", (line) => {
    const trimmed = String(line || "").trim();
    if (!trimmed) return;
    const parsed = normalizeCode(trimmed);
    if (parsed && parsed.prefix === expectedPrefix) {
      finish(resolveDone, parsed.code);
    } else if (parsed && parsed.prefix !== expectedPrefix) {
      console.log(
        dim(`  Pairing code prefix (${parsed.prefix}) does not match ${expectedPrefix}. Waiting for ${expectedPrefix}-XXXX-XXXX…`),
      );
    } else {
      console.log(
        dim(`  Not a valid pairing code (expected ${expectedPrefix}-XXXX-XXXX). Waiting for browser callback…`),
      );
    }
  });

  const timer = setTimeout(() => {
    finish(
      rejectDone,
      new Error(
        "Timed out waiting for browser authorization. Run `npx hallpassai auth` again or pass a code with `npx hallpassai auth <CODE>`.",
      ),
    );
  }, timeoutMs);
  timer.unref?.();

  try {
    const code = await resultPromise;
    finish(resolveDone, code);
    return code;
  } catch (err) {
    finish(rejectDone, err);
    throw err;
  }
}

export const POPULAR_MODEL_IDS = [
  "deepseek-v4.1-flash",
  "claude-opus-5.5",
  "claude-sonnet-5.5",
  "gpt-6.1-sol",
  "gemini-4-carbon",
  "kimi-k3.1-pro",
  "qwen3.8-27b",
  "grok-4.3",
];

export function orderModelsWithPopularFirst(models = [], topCount = 5) {
  const byId = new Map();
  for (const m of models) {
    if (m?.id && !byId.has(m.id)) byId.set(m.id, m);
  }
  const popular = [];
  const seen = new Set();
  for (const pid of POPULAR_MODEL_IDS) {
    if (popular.length >= topCount) break;
    const hit = byId.get(pid);
    if (hit) {
      seen.add(hit.id);
      popular.push({ ...hit, isPopular: true });
    }
  }
  const rest = [];
  for (const m of models) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    if (popular.length < topCount) {
      popular.push({ ...m, isPopular: true });
    } else {
      rest.push({ ...m, isPopular: false });
    }
  }
  return [...popular, ...rest];
}

export function filterModelsByQuery(models = [], query = "") {
  const terms = String(query || "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return models;
  return models.filter((m) => {
    const hay = `${m.id || ""} ${m.name || ""} ${m.provider || ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

function formatPickerRow(m, selected) {
  const ptr = selected ? green("❯") : " ";
  const idText = selected ? bold(green(cleanLog(m.id))) : cleanLog(m.id);
  const nameBit =
    m.name && m.name !== m.id ? ` ${dim(cleanLog(m.name))}` : "";
  const rate =
    typeof m.inputPerMillion === "number" &&
    typeof m.outputPerMillion === "number"
      ? ` · $${m.inputPerMillion}/$${m.outputPerMillion}`
      : "";
  const meta = dim(`${cleanLog(m.provider || "HallPass")}${rate}`);
  const star = m.isPopular ? yellow(" ★") : "";
  return `  ${ptr} ${idText}${star}${nameBit} ${dim("·")} ${meta}`;
}

export async function pickModelInteractive(
  models,
  {
    title = "Select a model to add",
    initialQuery = "",
    input = process.stdin,
    output = process.stdout,
    windowSize = 10,
  } = {},
) {
  const ordered = orderModelsWithPopularFirst(models, 5);
  if (!ordered.length) return null;

  const canUseRawTty =
    typeof input?.setRawMode === "function" &&
    Boolean(input?.isTTY) &&
    Boolean(output?.isTTY);

  if (!canUseRawTty) {
    const writeLine = (line) => output.write(`${line}\n`);
    writeLine(`\n${bold(title)} ${dim(`(${ordered.length} available)`)}:`);
    const top = ordered.slice(0, Math.min(10, ordered.length));
    top.forEach((m, idx) => {
      const tag = m.isPopular ? " [popular]" : "";
      writeLine(`  ${idx + 1}. ${cleanLog(m.id)}${tag} (${cleanLog(m.provider || "HallPass")})`);
    });
    const rl = readline.createInterface({ input, output });
    try {
      while (true) {
        const ans = (
          await rl.question("\nPick a number, type to filter, or enter a model ID (blank to cancel): ")
        ).trim();
        if (!ans) return null;
        const num = Number(ans);
        if (Number.isInteger(num) && num >= 1 && num <= top.length) {
          return top[num - 1].id;
        }
        const exact = ordered.find((m) => m.id.toLowerCase() === ans.toLowerCase());
        if (exact) return exact.id;
        const matches = filterModelsByQuery(ordered, ans);
        if (matches.length === 1) return matches[0].id;
        if (!matches.length) {
          writeLine(`  No models matching "${cleanLog(ans)}". Try again.`);
          continue;
        }
        writeLine(`  Matches (${matches.length}):`);
        const shown = matches.slice(0, 8);
        shown.forEach((m, idx) => {
          writeLine(`    ${idx + 1}. ${cleanLog(m.id)} (${cleanLog(m.provider || "HallPass")})`);
        });
        const pick = (await rl.question("  Select number or model ID (blank to search again): ")).trim();
        if (!pick) continue;
        const pNum = Number(pick);
        if (Number.isInteger(pNum) && pNum >= 1 && pNum <= shown.length) {
          return shown[pNum - 1].id;
        }
        const pExact = matches.find((m) => m.id.toLowerCase() === pick.toLowerCase());
        if (pExact) return pExact.id;
      }
    } finally {
      rl.close();
    }
  }

  return new Promise((resolve) => {
    let query = String(initialQuery || "");
    let index = 0;
    let renderedLines = 0;
    const prevRaw = Boolean(input.isRaw);

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[?25l");

    const render = () => {
      if (renderedLines > 0) {
        output.write(`\x1b[${renderedLines}A\r\x1b[J`);
      }
      const filtered = filterModelsByQuery(ordered, query);
      if (index >= filtered.length) index = Math.max(0, filtered.length - 1);
      if (index < 0) index = 0;

      const lines = [];
      lines.push(
        `${bold(title)} ${dim("(↑/↓ cycle · type to filter · Enter select · Esc cancel)")}`,
      );
      lines.push(
        `${dim("Filter:")} ${query ? bold(cleanLog(query)) : dim("type model name or provider…")}`,
      );
      lines.push("");

      if (!filtered.length) {
        lines.push(`  ${dim(`No models match "${cleanLog(query)}". Press Backspace to edit.`)}`);
      } else {
        const win = Math.min(windowSize, filtered.length);
        let start = Math.max(0, index - Math.floor(win / 2));
        if (start + win > filtered.length) start = Math.max(0, filtered.length - win);
        const slice = filtered.slice(start, start + win);
        let sawPopularHeader = false;
        let sawRestHeader = false;

        slice.forEach((m, offset) => {
          const absIdx = start + offset;
          if (!query && m.isPopular && !sawPopularHeader) {
            lines.push(`  ${yellow(bold("★ Popular"))}`);
            sawPopularHeader = true;
          } else if (!query && !m.isPopular && !sawRestHeader) {
            lines.push(`  ${dim("── All models ──")}`);
            sawRestHeader = true;
          }
          lines.push(formatPickerRow(m, absIdx === index));
        });

        if (filtered.length > win) {
          lines.push(
            `  ${dim(`showing ${start + 1}–${start + slice.length} of ${filtered.length}`)}`,
          );
        }
      }

      output.write(lines.join("\n") + "\n");
      renderedLines = lines.length;
    };

    const cleanup = (selectedId) => {
      input.off("keypress", onKeypress);
      if (renderedLines > 0) {
        output.write(`\x1b[${renderedLines}A\r\x1b[J`);
      }
      output.write("\x1b[?25h");
      try {
        input.setRawMode(prevRaw);
      } catch {}
      input.pause();
      resolve(selectedId);
    };

    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup(null);
        return;
      }
      if (key.name === "escape") {
        cleanup(null);
        return;
      }
      const filtered = filterModelsByQuery(ordered, query);
      if (key.name === "return" || key.name === "enter") {
        const chosen = filtered[index];
        if (chosen) cleanup(chosen.id);
        return;
      }
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        if (filtered.length) index = (index - 1 + filtered.length) % filtered.length;
        render();
        return;
      }
      if (key.name === "down" || (key.ctrl && key.name === "n") || key.name === "tab") {
        if (filtered.length) index = (index + 1) % filtered.length;
        render();
        return;
      }
      if (key.name === "pageup") {
        if (filtered.length) index = Math.max(0, index - 8);
        render();
        return;
      }
      if (key.name === "pagedown") {
        if (filtered.length) index = Math.min(filtered.length - 1, index + 8);
        render();
        return;
      }
      if (key.name === "backspace") {
        if (query.length) {
          query = query.slice(0, -1);
          index = 0;
          render();
        }
        return;
      }
      if (key.ctrl && key.name === "u") {
        if (query.length) {
          query = "";
          index = 0;
          render();
        }
        return;
      }
      if (str && !key.ctrl && !key.meta && str.length === 1 && str.charCodeAt(0) >= 0x20) {
        query += str;
        index = 0;
        render();
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

const toolNames = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", copilot: "Copilot CLI", cursor: "Cursor", cline: "Cline" };
const nativeCommand = (agent) => agent === "claude-code" ? "claude" : agent;
const coexistHint = {
  "claude-code": "Use the separate Claude launcher printed after setup for HallPass.",
  codex: "Use `codex -p hallpass` for HallPass.",
  opencode: "Choose a HallPass model from `/models` in OpenCode.",
  copilot: "Use the separate Copilot launcher printed after setup for HallPass.",
  cline: "Use `npx hallpassai run cline` for isolated HallPass sessions.",
};

async function chooseSetupOption(question, options, preferred, { input, output }) {
  const rl = readline.createInterface({ input, output });
  try {
    output.write(`\n${question}\n`);
    options.forEach((option, i) => output.write(`  ${i + 1}. ${option.label}\n`));
    while (true) {
      const answer = (await rl.question(`Choice [${preferred + 1}] or q to cancel: `)).trim();
      if (/^(q|quit)$/i.test(answer)) return null;
      if (!answer) return options[preferred].value;
      if (/^[1-9]$/.test(answer) && options[Number(answer) - 1]) return options[Number(answer) - 1].value;
      output.write("Enter a listed number or q.\n");
    }
  } finally {
    rl.close();
  }
}

export async function main(
  argv = process.argv.slice(2),
  {
    fetcher,
    input = process.stdin,
    output = process.stdout,
    interactive,
    openBrowser,
  } = {},
) {
  const interactiveTty = isInteractiveTerminal({ input, output, interactive });
  const args = parseArgs(argv);
  if (!argv.length && interactiveTty) {
    const connected = Object.keys(readStoredCredentials().keys);
    if (connected.length) {
      console.log(`Configured tools: ${connected.map(cleanLog).join(", ")}. See routing with \`hallpassai status\`.`);
      printHelp();
      return 0;
    }
    args.command = "setup";
  }
  if (args.command === "help") {
    printHelp();
    return 0;
  }
  if (args.command === "version") {
    console.log(pkg.version);
    return 0;
  }
  if (args.continueThread && (
    args.command !== "pause" || (args.agent && args.agent !== "codex") ||
    args.code || args.passThroughArgs.length || args.dryRun
  )) {
    console.error(red("Use `hallpassai pause codex --continue` to pick a saved thread."));
    return 1;
  }
  if (args.reasoning && !VALID_REASONING_LEVELS.has(args.reasoning)) {
    console.error(
      red(
        `Invalid --reasoning "${cleanLog(args.reasoning)}". Choose one of: auto, none, minimal, low, medium, high, max, xhigh, ultra`,
      ),
    );
    return 1;
  }

  const validateAgentFlag = () => {
    if (
      args.agent &&
      args.agent !== "all" &&
      !SUPPORTED_AGENTS.includes(args.agent)
    ) {
      console.error(
        red(
          `Unknown agent: ${cleanLog(args.agent)}. Choose one of: ${SUPPORTED_AGENTS.join(", ")}`,
        ),
      );
      return false;
    }
    return true;
  };

  if (args.command === "pause" || args.command === "resume") {
    if (!validateAgentFlag()) return 1;
    const target = args.agent || (args.continueThread ? "codex" : "all");
    const creds = readStoredCredentials();
    const first = Object.values(creds.keys || {})[0];
    if (!first) {
      console.error(
        red(
          "No HallPass tools configured yet. Pair first at https://app.hallpassai.com/start.html#connect",
        ),
      );
      return 1;
    }
    if (args.command === "pause") {
      if (target !== "all" && !creds.keys?.[target]) {
        console.error(
          red(`${cleanLog(target)} is not configured yet. Run \`npx hallpassai auth\` first.`),
        );
        return 1;
      }
      let continuation;
      if (args.continueThread) {
        if (!interactiveTty) {
          console.error(red("Run `hallpassai pause codex --continue` in an interactive terminal."));
          return 1;
        }
        if (args.modelArg && !isValidModelId(args.modelArg)) {
          console.error(red(`Invalid model identifier: ${cleanLog(args.modelArg)}`));
          return 1;
        }
        try {
          continuation = prepareCodexSubscriptionResume({ model: args.modelArg });
        } catch (error) {
          console.error(red(cleanLog(error.message)));
          return 1;
        }
      }
      const paused = pauseAgent(target, { codexSubscription: Boolean(continuation) });
      if (!paused.length) {
        console.error(red("No matching HallPass tools to pause."));
        return 1;
      }
      const autoPaused = paused.filter((p) => !p.manual);
      if (autoPaused.length) {
        console.log(
          `${green("✓")} Paused HallPass default routing${target === "all" ? "" : ` for ${bold(cleanLog(target))}`} (keys & credits preserved).`,
        );
      }
      for (const item of paused) {
        if (item.manual) {
          console.log(`  ${yellow("note")} ${cleanLog(item.agent)}: ${cleanLog(item.note)}`);
        } else {
          console.log(`  ${dim("restored native default")} ${cleanLog(item.agent)}`);
        }
      }
      if (continuation) {
        console.log("  Choose the thread to continue on your ChatGPT subscription.");
      } else if (autoPaused.some((item) => item.continueWithSubscription)) {
        console.log("  Open your saved conversation with `codex resume`. Its next turn uses your ChatGPT account.");
        console.log(dim("  If your Codex version hides the thread, use `hallpassai pause codex --continue`."));
      } else if (autoPaused.some(({ agent }) => agent === "codex")) {
        console.log("  Continue a saved thread on your ChatGPT subscription with `npx hallpassai pause codex --continue`.");
      }
      if (autoPaused.length) {
        console.log(dim("  Re-enable anytime with `npx hallpassai resume` or run once with `npx hallpassai run`."));
      }
      if (!telemetryDisabled()) {
        await sendCliEvent(
          "cli_paused",
          {
            origin: args.origin,
            apiBase: first.apiBase,
            token: first.token,
            meta: buildCliMeta({
              cliVersion: pkg.version,
              anonymousId: getAnonymousId(),
              targetHarness: target,
              configuredHarnesses: paused.map((p) => p.agent),
            }),
          },
          fetcher ? { fetcher } : undefined,
        );
      }
      if (continuation) {
        const launched = spawnSync(continuation.command, continuation.args, {
          stdio: "inherit",
          env: continuation.env,
        });
        if (launched.error) {
          console.error(red(`Could not launch Codex: ${cleanLog(launched.error.message)}`));
        }
        return launched.status ?? 1;
      }
      return 0;
    }
    if (target !== "all" && !creds.keys?.[target]) {
      console.error(
        red(`${cleanLog(target)} is not configured yet. Run \`npx hallpassai auth\` first.`),
      );
      return 1;
    }
    const catalogModels = await fetchCatalogDetails(
      { apiBase: first.apiBase, origin: args.origin },
      fetcher ? { fetcher } : undefined,
    );
    const resumed = resumeAgent(target, { catalogModels });
    if (!resumed.length) {
      console.error(red("No matching HallPass tools to resume."));
      return 1;
    }
    for (const item of resumed) {
      if (item.agent === "cursor") {
        console.log(`  In Cursor Settings → Models, enable the saved HallPass base URL, then the OpenAI key. Select ${cleanLog(item.model)} in chat.`);
        continue;
      }
      console.log(
        `${green("✓")} Resumed ${bold(cleanLog(item.agent))} → ${bold(cleanLog(item.model))}`,
      );
    }
    if (!telemetryDisabled()) {
      await sendCliEvent(
        "cli_resumed",
        {
          origin: args.origin,
          apiBase: first.apiBase,
          token: first.token,
          meta: buildCliMeta({
            cliVersion: pkg.version,
            anonymousId: getAnonymousId(),
            targetHarness: target,
            configuredHarnesses: resumed.map((r) => r.agent),
          }),
        },
        fetcher ? { fetcher } : undefined,
      );
    }
    return 0;
  }

  if (args.command === "undo" || args.command === "uninstall") {
    if (!validateAgentFlag()) return 1;
    const target = args.agent || "all";
    const isUninstall = args.command === "uninstall";
    const creds = readStoredCredentials();
    const anonId = !telemetryDisabled() ? getAnonymousId() : undefined;
    const allEntries = Object.entries(creds.keys || {});
    const matchingEntries = allEntries.filter(
      ([k]) => target === "all" || k === target,
    );
    const nonMatchingTokens = new Set(
      allEntries
        .filter(([k]) => target !== "all" && k !== target)
        .map(([, v]) => v?.token)
        .filter(Boolean),
    );
    const hadCursor = matchingEntries.some(([k]) => k === "cursor");
    const meta = buildCliMeta({
      cliVersion: pkg.version,
      anonymousId: anonId,
      targetHarness: target,
      configuredHarnesses: matchingEntries.map(([k]) => k),
    });

    let revokedCount = 0;
    if (isUninstall && !args.keepKeys && matchingEntries.length) {
      const seenTokens = new Set();
      for (const [, info] of matchingEntries) {
        if (!info?.token || seenTokens.has(info.token)) continue;
        // Never revoke a legacy shared token if another configured tool on this machine still depends on it.
        if (nonMatchingTokens.has(info.token)) continue;
        seenTokens.add(info.token);
        const ok = await revokeServerToken(
          { origin: args.origin, apiBase: info.apiBase, token: info.token, meta },
          fetcher ? { fetcher } : undefined,
        );
        if (ok) revokedCount++;
      }
    } else if (!telemetryDisabled() && matchingEntries.length) {
      const first = matchingEntries[0][1];
      await sendCliEvent(
        isUninstall ? "cli_uninstalled" : "cli_undo",
        { origin: args.origin, apiBase: first?.apiBase, token: first?.token, meta },
        fetcher ? { fetcher } : undefined,
      );
    }

    const restored = undoAgent(target, { fullCleanup: isUninstall });
    if (isUninstall) {
      console.log(
        `${green("✓")} HallPass uninstalled${target === "all" ? "" : ` for ${bold(cleanLog(target))}`}.`,
      );
      if (revokedCount > 0) {
        console.log(
          `  ${dim("revoked")} ${revokedCount} HallPass API key${revokedCount === 1 ? "" : "s"} on server`,
        );
      }
      if (restored.length) {
        for (const f of restored) console.log(`  ${dim("cleaned")} ${f}`);
      }
      if (hadCursor) {
        console.log(
          `  ${dim("note")}    In Cursor → Settings → Models, disable the OpenAI key and the base URL override, then select Auto in chat.`,
        );
      }
    } else {
      console.log(
        restored.length
          ? `${green("✓")} Restored ${restored.length} file(s):\n  ${restored.join("\n  ")}`
          : `${green("✓")} HallPass credentials cleared.`,
      );
    }
    return 0;
  }

  if (
    args.command === "status" ||
    args.command === "doctor" ||
    args.command === "usage"
  ) {
    if (!validateAgentFlag()) return 1;
    const creds = readStoredCredentials();
    const entries = Object.entries(creds.keys || {}).filter(
      ([k]) => !args.agent || args.agent === "all" || k === args.agent,
    );
    const anonId = !telemetryDisabled() ? getAnonymousId() : undefined;
    if (!entries.length) {
      if (args.json) {
        console.log(JSON.stringify({ ok: false, configured: false, tools: [] }));
      } else {
        console.log("No HallPass tools configured on this machine yet.");
        console.log(
          "Generate a pairing code at https://app.hallpassai.com/start.html#connect",
        );
      }
      return 0;
    }

    const first = entries[0][1];
    let ledger = null;
    for (const [, entry] of entries) {
      if (!entry?.token || !entry?.apiBase) continue;
      ledger = await fetchCliUsage(
        {
          origin: args.origin,
          apiBase: entry.apiBase,
          token: entry.token,
          limit: 15,
        },
        fetcher ? { fetcher } : undefined,
      );
      if (ledger) break;
    }

    if (args.command === "usage") {
      if (!ledger) {
        if (args.json) {
          console.log(JSON.stringify({ ok: false, error: "usage_unavailable" }));
        } else {
          console.error(red("Could not load HallPass credit ledger for stored key."));
        }
        return 1;
      }
      if (args.json) {
        console.log(JSON.stringify(ledger, null, 2));
      } else {
        const acct = ledger.account || {};
        const heldNote =
          Number(acct.heldMicros || 0) > 0
            ? ` ${dim(`(${formatMicrosUsd(acct.heldMicros)} held settling)`)}`
            : "";
        console.log(
          `${bold("HallPass Credits:")} ${green(bold(formatMicrosUsd(acct.availableMicros)))} available${heldNote}`,
        );
        console.log(
          `  ${dim("account ledger")}  ${acct.completedRequests || 0} completed requests · ${formatMicrosUsd(acct.totalCostMicros, { exact: true })} total spent`,
        );
        console.log(
          `  ${dim("tokens")}          ${formatCompactTokens(acct.inputTokens)} in (${formatCompactTokens(acct.cachedInputTokens)} cache read, ${formatCompactTokens(acct.cacheWriteTokens)} cache write) · ${formatCompactTokens(acct.outputTokens)} out`,
        );
        if (Array.isArray(ledger.recentRequests) && ledger.recentRequests.length) {
          console.log(`\n${bold("Recent ledger entries:")}`);
          for (const r of ledger.recentRequests.slice(0, 12)) {
            const u = r.usage || {};
            const cacheBit =
              u.cachedInput || u.cacheWriteInput
                ? ` (${u.cachedInput ? `${formatCompactTokens(u.cachedInput)} cached` : ""}${u.cachedInput && u.cacheWriteInput ? ", " : ""}${u.cacheWriteInput ? `${formatCompactTokens(u.cacheWriteInput)} write` : ""})`
                : "";
            const tokStr =
              u.input !== undefined
                ? `${formatCompactTokens(u.input)} in${cacheBit} / ${formatCompactTokens(u.output)} out`
                : r.status;
            const costStr =
              r.costMicros !== null && r.costMicros !== undefined
                ? formatMicrosUsd(r.costMicros, { exact: true })
                : `pending (${formatMicrosUsd(r.reservedMicros)} held)`;
            const src = cleanLog(r.harness || r.protocol || "api");
            console.log(
              `  • ${bold(cleanLog(r.model))} ${dim(`[${src}]`)} — ${costStr} ${dim(`· ${tokStr}`)}`,
            );
          }
        }
      }
      if (!telemetryDisabled()) {
        await sendCliEvent(
          "cli_usage",
          {
            origin: args.origin,
            apiBase: first?.apiBase,
            token: first?.token,
            meta: buildCliMeta({
              cliVersion: pkg.version,
              anonymousId: anonId,
              configuredHarnesses: entries.map(([k]) => k),
            }),
          },
          fetcher ? { fetcher } : undefined,
        );
      }
      return 0;
    }

    let allHealthy = true;
    const toolStatuses = [];
    for (const [agent, info] of entries) {
      const live = await fetchLiveModels(
        { apiBase: info.apiBase, token: info.token },
        fetcher ? { fetcher } : undefined,
      );
      const disk = inspectAgentConfig(agent);
      const activeModel = disk.diskModel || info.model;
      const activeReasoning = disk.diskReasoning ?? info.reasoning ?? null;
      const modelOk =
        !live.models.length || live.models.includes(activeModel);
      const healthy = live.ok && disk.ok && modelOk;
      if (!healthy) allHealthy = false;
      toolStatuses.push({
        agent,
        healthy,
        paused: Boolean(disk.paused),
        mode: info.mode || "default",
        model: activeModel,
        reasoning: activeReasoning,
        apiBase: info.apiBase,
        latencyMs: live.latencyMs,
      });
      if (!args.json) {
        const reasoningBadge = activeReasoning
          ? ` · reasoning: ${cleanLog(activeReasoning)}`
          : "";
        const modeBadge = disk.paused
          ? ` · ${yellow("paused")}`
          : info.mode === "coexist"
            ? ` · ${dim("coexist")}`
            : "";
        console.log(
          `${healthy ? green("✓") : red("✗")} ${bold(cleanLog(agent))} — model: ${cleanLog(activeModel)}${reasoningBadge}${modeBadge} · endpoint: ${cleanLog(info.apiBase)} · key: ${live.ok ? `active (${live.latencyMs}ms)` : "invalid or unreachable"}`,
        );
        if (args.command === "doctor" || !disk.ok || !modelOk) {
          console.log(
            `  ${dim("config")}  ${disk.ok ? "ok" : "drift detected"} — ${cleanLog(disk.note)}`,
          );
          console.log(`  ${dim("endpoint")} ${cleanLog(info.apiBase)}`);
          if (live.ok && !modelOk) {
            console.log(
              `  ${dim("warning")} Model "${cleanLog(activeModel)}" not in live catalog (${live.models.slice(0, 4).map(cleanLog).join(", ")}). Switch with \`npx hallpassai use <model>\`.`,
            );
          }
        }
      }
    }
    if (args.json) {
      console.log(
        JSON.stringify(
          { ok: allHealthy, tools: toolStatuses, ledger: ledger || null },
          null,
          2,
        ),
      );
    } else if (ledger?.account) {
      const acct = ledger.account;
      const availMicros = Number(acct.availableMicros || 0);
      const heldBit =
        Number(acct.heldMicros || 0) > 0
          ? ` · ${formatMicrosUsd(acct.heldMicros)} held`
          : "";
      console.log(
        `  ${dim("credits")} ${availMicros > 0 ? bold(formatMicrosUsd(availMicros)) : yellow(bold("$0.00"))} available${heldBit} · ${acct.completedRequests || 0} requests (${formatMicrosUsd(acct.totalCostMicros, { exact: true })} spent — \`npx hallpassai usage\` for ledger)`,
      );
      if (availMicros <= 0) {
        console.log(
          `  ${yellow("!")} Out of credits — top up 2x packs at https://app.hallpassai.com/start.html#billing or run \`npx hallpassai pause\`.`,
        );
      }
    }
    if (!telemetryDisabled()) {
      await sendCliEvent(
        args.command === "doctor" ? "cli_doctor" : "cli_status",
        {
          origin: args.origin,
          apiBase: first?.apiBase,
          token: first?.token,
          meta: buildCliMeta({
            cliVersion: pkg.version,
            anonymousId: anonId,
            configuredHarnesses: entries.map(([k]) => k),
            healthy: allHealthy,
          }),
        },
        fetcher ? { fetcher } : undefined,
      );
    }
    return allHealthy ? 0 : 1;
  }

  const isModelCompatibleWithAgent = (agent, modelObj) => {
    if (!modelObj) return true;
    if (agent === "copilot" && modelObj.protocols?.includes("responses")) return true;
    const reqProto =
      agent === "claude-code"
        ? "messages"
        : agent === "codex"
          ? "responses"
          : "chat/completions";
    if (
      Array.isArray(modelObj.protocols) &&
      modelObj.protocols.length > 0 &&
      !modelObj.protocols.includes(reqProto)
    ) {
      return false;
    }
    return true;
  };

  if (args.command === "add") {
    if (!validateAgentFlag()) return 1;
    const creds = readStoredCredentials();
    const explicit = args.agent && args.agent !== "all";
    const targets = explicit ? [args.agent] : SUPPORTED_AGENTS.filter((agent) => creds.keys?.[agent]);
    if (!targets.length) {
      console.error(
        red(
          "Set up a tool first with `npx hallpassai setup <harness>`.",
        ),
      );
      return 1;
    }
    const first = creds.keys[targets[0]];
    if (!first) {
      console.error(
        red(
          `${cleanLog(targets[0])} is not configured yet. Run \`npx hallpassai auth\` first.`,
        ),
      );
      return 1;
    }
    const catalogModels = await fetchCatalogDetails(
      { apiBase: first?.apiBase, origin: args.origin },
      fetcher ? { fetcher } : undefined,
    );

    let chosenModelId = args.modelArg;
    if (!chosenModelId) {
      if (!interactiveTty) {
        console.error(
          red("Provide a model ID to add (e.g. `npx hallpassai add deepseek-v4.1-flash`), or run interactively to pick one."),
        );
        return 1;
      }
      let pool = catalogModels;
      if (!pool.length && first?.token && first?.apiBase) {
        const live = await fetchLiveModels(
          { apiBase: first.apiBase, token: first.token },
          fetcher ? { fetcher } : undefined,
        );
        if (live.ok) {
          pool = live.models.map((id) => ({
            id,
            name: id,
            provider: "HallPass",
            protocols: ["messages", "responses", "chat/completions"],
          }));
        }
      }
      const compatiblePool = pool.filter((m) =>
        targets.some((agent) => isModelCompatibleWithAgent(agent, m)),
      );
      if (!compatiblePool.length) {
        console.error(red("Could not load compatible HallPass models."));
        return 1;
      }
      const picked = await pickModelInteractive(compatiblePool, {
        title: `Add a model to ${targets.join(", ")}`,
        input,
        output,
      });
      if (!picked) {
        console.log(dim("Cancelled."));
        return 0;
      }
      chosenModelId = picked;
    }

    if (!isValidModelId(chosenModelId)) {
      console.error(
        red("Provide a valid model ID to add (e.g. `npx hallpassai add deepseek-v4.1-flash`)."),
      );
      return 1;
    }

    let catalogMatch = catalogModels.length
      ? catalogModels.find((m) => m.id === chosenModelId)
      : null;
    if (catalogModels.length && !catalogMatch) {
      const compatiblePool = catalogModels.filter((m) =>
        targets.some((agent) => isModelCompatibleWithAgent(agent, m)),
      );
      const fuzzy = filterModelsByQuery(compatiblePool, chosenModelId);
      if (fuzzy.length === 1) {
        chosenModelId = fuzzy[0].id;
        catalogMatch = fuzzy[0];
      } else if (interactiveTty && compatiblePool.length) {
        const picked = await pickModelInteractive(compatiblePool, {
          title: `Add a model to ${targets.join(", ")}`,
          initialQuery: chosenModelId,
          input,
          output,
        });
        if (!picked) {
          console.log(dim("Cancelled."));
          return 0;
        }
        chosenModelId = picked;
        catalogMatch = catalogModels.find((m) => m.id === chosenModelId) || null;
      } else {
        console.error(
          red(
            `Unknown model "${cleanLog(chosenModelId)}". Run \`npx hallpassai add\` to search interactively or \`npx hallpassai models\`.`,
          ),
        );
        return 1;
      }
    }
    const addedTo = [];
    let manual = false;
    let failed = false;
    let previewed = false;
    for (const agent of targets) {
      if (catalogMatch && !isModelCompatibleWithAgent(agent, catalogMatch)) {
        console.error(`Skipped ${agent}: its API does not support "${cleanLog(chosenModelId)}".`);
        continue;
      }
      if (agent === "codex" && !catalogMatch) {
        console.error("Codex discovers models from HallPass. Could not verify this model in the catalog. Retry when the gateway is reachable.");
        failed = true;
        continue;
      }
      if (args.dryRun) {
        console.log(`Would add ${cleanLog(chosenModelId)} to ${agent}${agent === "cursor" ? " via Cursor Settings → Models" : ""}.`);
        previewed = true;
        continue;
      }
      try {
        const res = addModelToAgent(agent, chosenModelId, { catalogModels });
        if (res.manual) {
          manual = true;
          if (interactiveTty && !isRemoteOrHeadlessEnv()) {
            if (args.launch !== false && !args.noBrowser) (openBrowser || openSystemBrowser)("cursor://anysphere.cursor-deeplink/settings");
            if (copyToClipboard(chosenModelId)) console.log("Copied the model ID to your clipboard.");
          }
          console.log(`Finish adding ${bold(cleanLog(res.model))} in ${bold(agent)}.`);
        } else {
          addedTo.push(agent);
          console.log(`${green("✓")} ${bold(cleanLog(res.model))} is available in ${bold(agent)}`);
        }
        for (const f of res.files) console.log(`  ${dim("updated")} ${f}`);
        if (res.hint) console.log(`  ${dim("tip")}     ${res.hint}`);
      } catch (err) {
        failed = true;
        console.error(red(`${agent}: ${cleanLog(err.message)}`));
      }
    }
    if (previewed) return failed ? 1 : 0;
    if (!addedTo.length && !manual) return 1;
    if (addedTo.length && !telemetryDisabled()) {
      await sendCliEvent(
        "cli_model_added",
        {
          origin: args.origin,
          apiBase: first?.apiBase,
          token: first?.token,
          meta: buildCliMeta({
            cliVersion: pkg.version,
            anonymousId: getAnonymousId(),
            modelId: chosenModelId,
            configuredHarnesses: addedTo,
          }),
        },
        fetcher ? { fetcher } : undefined,
      );
    }
    return failed ? 1 : 0;
  }

  if (args.command === "run") {
    if (!validateAgentFlag()) return 1;
    // Stock help and version are local operations, including before the first pairing.
    if (nativeDiscovery(args.agent, args.passThroughArgs) || (args.agent === "cursor" && args.passThroughArgs.length)) {
      const binary = nativeName(args.agent);
      const status = runHarness(args.agent, resolveRealBinary(binary), args.passThroughArgs);
      // OpenCode help ends without a newline. npm exec erases the current line
      // when its terminal spinner closes, including the final option's text.
      if (binary === "opencode" && ["-h", "--help"].includes(args.passThroughArgs.at(-1)) &&
          process.stderr.isTTY && process.env.npm_command === "exec") process.stderr.write("\n");
      return status;
    }
    const creds = readStoredCredentials();
    if (args.agent === "cursor") {
      const cEntry = creds.keys?.cursor;
      console.log(
        `${bold("Cursor")} uses the model configured in the desktop app. Run npx hallpassai run cursor --help for editor options.`,
      );
      if (cEntry) {
        console.log(`  Base URL: ${cleanLog(cEntry.apiBase)}`);
        console.log(`  Model:    ${cleanLog(cEntry.model)}`);
      }
      console.log(
        dim("  Configure it under Cursor → Settings → Models → Override OpenAI Base URL."),
      );
      return 0;
    }
    const configuredAgents = Object.keys(creds.keys || {}).filter(
      (k) => k !== "cursor",
    );
    if (!configuredAgents.length) {
      const authCommand = "npx hallpassai auth" + (args.agent && args.agent !== "all" ? " --harness " + args.agent : "");
      console.error("Pair this terminal with HallPass to start a session.");
      console.error("\n  " + authCommand);
      console.error("\nOr open https://app.hallpassai.com/start.html#connect");
      return 1;
    }
    if (args.agent && args.agent !== "all" && !creds.keys[args.agent]) {
      console.error(`Set up ${args.agent} first with \`hallpassai setup ${args.agent}\`.`);
      return 1;
    }
    const first = creds.keys[args.agent] || creds.keys[configuredAgents[0]];
    const catalogModels = await fetchCatalogDetails(
      { apiBase: first?.apiBase, origin: args.origin },
      fetcher ? { fetcher } : undefined,
    );
    let chosenAgent =
      args.agent && args.agent !== "all" ? args.agent : null;
    if (!chosenAgent) {
      if (args.modelArg) {
        const mObj = catalogModels.find((m) => m.id === args.modelArg);
        chosenAgent =
          configuredAgents.find((a) =>
            isModelCompatibleWithAgent(a, mObj, catalogModels),
          ) || configuredAgents[0];
      } else {
        chosenAgent = configuredAgents[0];
      }
    }
    const entry = creds.keys[chosenAgent];
    const chosenModel = args.modelArg || entry.model;
    if (!isValidModelId(chosenModel)) {
      console.error(red(`Invalid model identifier: ${cleanLog(String(chosenModel))}`));
      return 1;
    }
    const validatedApiBase = validateEndpointUrl(entry.apiBase);
    const chosenReasoning = args.reasoning || entry.reasoning || null;
    const spec = buildEphemeralLaunchSpec(chosenAgent, {
      token: entry.token,
      apiBase: validatedApiBase,
      model: chosenModel,
      reasoning: chosenReasoning,
      catalogModels,
      extraArgs: args.passThroughArgs,
    });
    if (!telemetryDisabled()) {
      await sendCliEvent(
        "cli_launched",
        {
          origin: args.origin,
          apiBase: entry.apiBase,
          token: entry.token,
          meta: buildCliMeta({
            cliVersion: pkg.version,
            anonymousId: getAnonymousId(),
            targetHarness: chosenAgent,
            modelId: chosenModel,
          }),
        },
        fetcher ? { fetcher } : undefined,
      );
    }
    return runHarness(chosenAgent, spec.command, spec.args, spec.env);
  }

  if (args.command === "models") {
    if (!validateAgentFlag()) return 1;
    const creds = readStoredCredentials();
    const first = Object.values(creds.keys || {})[0];
    const detailed = await fetchCatalogDetails(
      {
        apiBase: first?.apiBase || null,
        origin: args.origin || (!first?.apiBase ? resolveOrigin(null) : null),
      },
      fetcher ? { fetcher } : undefined,
    );
    let rows = detailed;
    if (!rows.length && first?.token && first?.apiBase) {
      const live = await fetchLiveModels(
        { apiBase: first.apiBase, token: first.token },
        fetcher ? { fetcher } : undefined,
      );
      if (live.ok) {
        rows = live.models.map((id) => ({
          id,
          name: id,
          provider: "HallPass",
          protocols: [],
          reasoning: false,
        }));
      }
    }
    if (!rows.length) {
      console.error(red("Could not load HallPass model catalog."));
      return 1;
    }
    if (args.agent && args.agent !== "all") {
      rows = rows.filter((m) => isModelCompatibleWithAgent(args.agent, m, detailed));
    }
    if (args.provider) {
      const p = args.provider.toLowerCase();
      rows = rows.filter((m) => m.provider.toLowerCase().includes(p));
    }
    if (args.search) {
      const terms = args.search.toLowerCase().trim().split(/\s+/).filter(Boolean);
      rows = rows.filter((m) => {
        const hay = `${m.id} ${m.name} ${m.provider}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
    console.log(`${bold(`Available models (${rows.length}):`)}`);
    const byProvider = new Map();
    for (const m of rows) {
      if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
      byProvider.get(m.provider).push(m);
    }
    for (const [provider, list] of byProvider.entries()) {
      console.log(`\n  ${bold(cleanLog(provider))}`);
      for (const m of list) {
        const ctx = m.contextLength
          ? m.contextLength >= 950000
            ? `${Math.round(m.contextLength / 1000000)}M ctx`
            : `${Math.round(m.contextLength / 1000)}K ctx`
          : "";
        const rate =
          typeof m.inputPerMillion === "number" &&
          typeof m.outputPerMillion === "number"
            ? `$${m.inputPerMillion}/$${m.outputPerMillion} per 1M`
            : "";
        const tags = [m.reasoning ? "reasoning" : "", ctx, rate]
          .filter(Boolean)
          .join(", ");
        console.log(
          `    • ${cleanLog(m.id)}${m.name && m.name !== m.id ? dim(` (${cleanLog(m.name)})`) : ""}${tags ? dim(` [${tags}]`) : ""}`,
        );
      }
    }
    console.log(
      dim(
        "\nSwitch default: `npx hallpassai use <model-id> -r high` · Add to picker: `npx hallpassai add <model-id>`",
      ),
    );
    return 0;
  }

  if (args.command === "use") {
    if (!validateAgentFlag()) return 1;
    const creds = readStoredCredentials();
    const explicitAgent = Boolean(args.agent && args.agent !== "all");
    const targets = explicitAgent
      ? [args.agent]
      : Object.keys(creds.keys || {});
    if (!targets.length) {
      console.error(
        red(
          "No HallPass tools configured yet. Pair first at https://app.hallpassai.com/start.html#connect",
        ),
      );
      return 1;
    }

    const first = creds.keys[targets[0]];
    if (!first) {
      console.error(
        red(
          `${cleanLog(targets[0])} is not configured yet. Run \`npx hallpassai auth\` first.`,
        ),
      );
      return 1;
    }
    const catalogModels = await fetchCatalogDetails(
      { apiBase: first?.apiBase, origin: args.origin },
      fetcher ? { fetcher } : undefined,
    );

    let chosenModel = args.modelArg;
    let chosenReasoning = args.reasoning;

    if (!chosenModel && !chosenReasoning && interactiveTty) {
      const scopedCatalog =
        explicitAgent && catalogModels.length
          ? catalogModels.filter((m) =>
              isModelCompatibleWithAgent(args.agent, m, catalogModels),
            )
          : catalogModels;
      const liveIds = scopedCatalog.length
        ? scopedCatalog.map((m) => m.id)
        : (
            await fetchLiveModels(
              { apiBase: first.apiBase, token: first.token },
              fetcher ? { fetcher } : undefined,
            )
          ).models;
      if (liveIds.length) {
        const previewCount = Math.min(25, liveIds.length);
        console.log(
          bold(
            `\nSelect a HallPass model${liveIds.length > previewCount ? ` (showing ${previewCount} of ${liveIds.length} — or type any model ID)` : ""}:`,
          ),
        );
        liveIds.slice(0, previewCount).forEach((id, idx) => {
          console.log(`  ${dim(`${idx + 1}.`)} ${cleanLog(id)}`);
        });
        const rl = readline.createInterface({ input, output });
        try {
          const ans = (
            await rl.question(
              `\nModel number or ID [keep ${targets.length > 1 ? "current per tool" : cleanLog(first.model)}]: `,
            )
          ).trim();
          if (ans) {
            const num = Number(ans);
            chosenModel =
              Number.isInteger(num) && num >= 1 && num <= previewCount
                ? liveIds[num - 1]
                : ans;
          } else if (targets.length === 1) {
            chosenModel = first.model;
          }
          const rAns = (
            await rl.question(
              `Reasoning effort (auto / low / medium / high / max) [${cleanLog(first.reasoning || "auto")}]: `,
            )
          )
            .trim()
            .toLowerCase();
          if (rAns) {
            if (!VALID_REASONING_LEVELS.has(rAns)) {
              console.error(
                red(
                  `Invalid reasoning effort "${cleanLog(rAns)}". Choose auto, none, minimal, low, medium, high, max, xhigh, or ultra.`,
                ),
              );
              return 1;
            }
            chosenReasoning = rAns;
          }
          if (!chosenModel && !chosenReasoning) {
            console.log(dim("No changes made."));
            return 0;
          }
        } finally {
          rl.close();
        }
      }
    }

    if (!chosenModel && !chosenReasoning) {
      console.error(
        red(
          "Provide a model ID and/or --reasoning flag (e.g. `npx hallpassai use claude-opus-5.5 --reasoning high`).",
        ),
      );
      return 1;
    }
    if (chosenModel && !isValidModelId(chosenModel)) {
      console.error(
        red("Provide a valid model ID (e.g. `npx hallpassai use claude-opus-5.5`)."),
      );
      return 1;
    }

    let catalogMatch =
      chosenModel && catalogModels.length
        ? catalogModels.find((m) => m.id === chosenModel)
        : null;
    if (chosenModel && catalogModels.length && !catalogMatch) {
      const compatiblePool = catalogModels.filter((m) =>
        targets.some((agent) => isModelCompatibleWithAgent(agent, m)),
      );
      const fuzzy = filterModelsByQuery(compatiblePool, chosenModel);
      if (fuzzy.length === 1) {
        chosenModel = fuzzy[0].id;
        catalogMatch = fuzzy[0];
      } else if (interactiveTty && compatiblePool.length) {
        const picked = await pickModelInteractive(compatiblePool, {
          title: `Select default model for ${targets.join(", ")}`,
          initialQuery: chosenModel,
          input,
          output,
        });
        if (!picked) {
          console.log(dim("Cancelled."));
          return 0;
        }
        chosenModel = picked;
        catalogMatch = catalogModels.find((m) => m.id === chosenModel) || null;
      } else {
        const suggestions = fuzzy.slice(0, 4).map((m) => m.id);
        console.error(
          red(
            `Unknown model "${cleanLog(chosenModel)}".${suggestions.length ? ` Did you mean: ${suggestions.map(cleanLog).join(", ")}?` : " Run `npx hallpassai use` to search interactively."}`,
          ),
        );
        return 1;
      }
    }

    const inferOfflineCompatible = () => true;

    const updatedAgents = [];
    for (const agent of targets) {
      if (chosenModel && !explicitAgent && targets.length > 1) {
        const compatible = catalogMatch
          ? isModelCompatibleWithAgent(agent, catalogMatch, catalogModels)
          : inferOfflineCompatible(agent, chosenModel);
        if (!compatible) {
          console.log(
            `  ${dim("skipped")} ${cleanLog(agent)} (${cleanLog(chosenModel)} is incompatible with ${cleanLog(agent)})`,
          );
          continue;
        }
      }
      if (
        chosenModel &&
        explicitAgent &&
        catalogMatch &&
        !isModelCompatibleWithAgent(agent, catalogMatch, catalogModels)
      ) {
        console.error(
          red(
            `Model "${cleanLog(chosenModel)}" is not compatible with ${cleanLog(agent)}. Use OpenCode for multi-provider models (` +
              `\`npx hallpassai use ${cleanLog(chosenModel)} --agent opencode\`).`,
          ),
        );
        return 1;
      }
      const targetModel = chosenModel || creds.keys[agent]?.model;
      const res = switchAgentModel(agent, targetModel, {
        reasoningEffort: chosenReasoning,
        catalogModels,
      });
      updatedAgents.push(agent);
      const actualModel = res.appliedModel || targetModel;
      const rLabel = res.appliedReasoning
        ? ` (reasoning: ${cleanLog(res.appliedReasoning)})`
        : chosenReasoning === "auto" || chosenReasoning === "none"
          ? " (reasoning: default)"
          : "";
      console.log(
        `${green("✓")} Updated ${bold(cleanLog(agent))} → model ${bold(cleanLog(actualModel))}${rLabel}`,
      );
      for (const f of res.files) console.log(`  ${dim("updated")} ${f}`);
      if (agent === "copilot" && creds.keys[agent]?.mode !== "coexist") {
        console.log(
          `  ${dim("note")}    Run \`source ~/.config/hallpass/copilot.env\` to apply in this shell.`,
        );
      }
      if (agent === "cursor") {
        console.log(
          `  ${dim("note")}    Add "${cleanLog(actualModel)}" in Cursor → Settings → Models.`,
        );
      }
    }
    if (!updatedAgents.length) {
      console.error(
        red(
          `No configured tool on this machine supports "${cleanLog(chosenModel)}". Configure OpenCode to run all 130+ multi-provider models.`,
        ),
      );
      return 1;
    }
    if (!telemetryDisabled()) {
      await sendCliEvent(
        "cli_model_switched",
        {
          origin: args.origin,
          apiBase: first?.apiBase,
          token: first?.token,
          meta: buildCliMeta({
            cliVersion: pkg.version,
            anonymousId: getAnonymousId(),
            modelId: chosenModel || first?.model,
            configuredHarnesses: updatedAgents,
          }),
        },
        fetcher ? { fetcher } : undefined,
      );
    }
    return 0;
  }

  if (!validateAgentFlag()) return 1;

  const setup = args.command === "setup";
  let savedSetup;
  if (setup) {
    if (args.agent === "all" || args.passThroughArgs.length || args.launch === true || args.modelArg) {
      console.error("Use `hallpassai setup <tool>` for one tool. Select a model with `hallpassai use` after setup.");
      return 1;
    }
    if (!args.agent) {
      if (!interactiveTty) {
        console.error(`Choose a tool: hallpassai setup <${SUPPORTED_AGENTS.join("|")}>.`);
        return 1;
      }
      const installed = detectInstalledAgents(undefined, undefined, { fallback: false });
      const choices = [...new Set([...installed, ...SUPPORTED_AGENTS])];
      args.agent = await chooseSetupOption("Which coding tool do you want to set up?", choices.map((agent) => ({
        value: agent, label: toolNames[agent] + (installed.includes(agent) ? " (detected)" : ""),
      })), 0, { input, output });
      if (!args.agent) return 0;
    }
    const agent = args.agent;
    savedSetup = !args.code && readStoredCredentials().keys[agent];
    if (args.dryRun && !args.mode && !interactiveTty) args.mode = savedSetup?.mode || (agent === "cursor" ? "default" : "coexist");
    if (agent === "cursor" && args.mode === "coexist") {
      console.error("Cursor uses a manual model configuration in Settings → Models.");
      return 1;
    }
    if (!args.mode && agent !== "cursor") {
      if (!interactiveTty) {
        console.error("Choose --default to use HallPass credits or --coexist to keep your current default.");
        return 1;
      }
      const keepDefault = savedSetup ? savedSetup.paused || savedSetup.mode === "coexist" : detectExistingSubscription(agent).detected;
      args.mode = await chooseSetupOption(`How should ${toolNames[agent]} use HallPass?`, [
        { value: "default", label: `Use HallPass credits when I open ${nativeCommand(agent)}` },
        { value: "coexist", label: `Keep my current default. ${coexistHint[agent]}` },
      ], keepDefault ? 1 : 0, { input, output });
      if (!args.mode) return 0;
    }
    args.mode ||= "default";
    args.launch = false;
  }

  if ((args.command === "auth" || setup) && !savedSetup && !args.code && !args.dryRun) {
    if (!interactiveTty) {
      console.error(
        red(
          "Non-interactive shell: pass a pairing code (npx hallpassai auth <CODE>).",
        ),
      );
      return 1;
    }
    const authOrigin = resolveOrigin(null, args.origin);
    args.code = await runBrowserAuthFlow({
      origin: authOrigin,
      agent: args.agent,
      noBrowser: args.noBrowser,
      input,
      output,
      openBrowser: openBrowser || openSystemBrowser,
    });
  }

  const parsedCode = args.code ? normalizeCode(args.code) : null;
  if (!parsedCode && !savedSetup && !(setup && args.dryRun)) {
    console.error(
      red("Run `npx hallpassai auth` to sign in, or pass a pairing code (`npx hallpassai auth HP-XXXX-XXXX`)."),
    );
    return 1;
  }

  if (args.dryRun) {
    const resolvedOrigin = resolveOrigin(parsedCode?.prefix, args.origin);
    const previewApiBase =
      resolvedOrigin === "https://app.hallpassai.com"
        ? "https://api.hallpassai.com/v1"
        : `${resolvedOrigin}/v1`;
    const targetHarness = args.agent || "all";
    const agents =
      targetHarness === "all" ? detectInstalledAgents() : [targetHarness];
    const previewPayload = {
      token: "hp_live_••••••••",
      apiBase: previewApiBase,
      model: "claude-sonnet-4-6",
      models: [
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          provider: "Anthropic",
          protocols: ["messages", "chat/completions"],
        },
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          provider: "OpenAI",
          protocols: ["responses", "chat/completions"],
        },
      ],
    };
    console.log(
      `${dim("→")} Previewing HallPass setup (no pairing code consumed)…`,
    );
    for (const agent of agents) {
      const res = configureAgent(agent, previewPayload, {
        dryRun: true,
        reasoningEffort: args.reasoning,
        mode: args.mode || "default",
      });
      console.log(
        `\n${bold(`[dry-run] ${agent}`)}${res.files.length ? ` (${res.files.join(", ")})` : ""}:`,
      );
      if (res.preview) console.log(res.preview);
    }
    return 0;
  }

  const anonId = !telemetryDisabled() ? getAnonymousId() : undefined;
  const detectedForAll = detectInstalledAgents();
  const claimMeta = buildCliMeta({
    cliVersion: pkg.version,
    anonymousId: anonId,
    targetHarness: args.agent || undefined,
  });

  let claimed;
  if (savedSetup) {
    const savedReachable = await verifyGatewayReachable(
      savedSetup,
      fetcher ? { fetcher } : undefined,
    );
    if (!savedReachable) {
      if (interactiveTty) {
        console.log(
          dim(`Saved HallPass key for ${cleanLog(args.agent)} is no longer active; starting fresh sign-in…`),
        );
        savedSetup = null;
        const authOrigin = resolveOrigin(null, args.origin);
        args.code = await runBrowserAuthFlow({
          origin: authOrigin,
          agent: args.agent,
          noBrowser: args.noBrowser,
          input,
          output,
          openBrowser: openBrowser || openSystemBrowser,
        });
      } else {
        console.error(`Could not verify the saved HallPass key for ${args.agent}. Check \`hallpassai doctor\` or rerun setup with a fresh pairing code.`);
        return 1;
      }
    }
  }
  if (savedSetup) {
    const models = await fetchCatalogDetails({ apiBase: savedSetup.apiBase, origin: args.origin }, fetcher ? { fetcher } : undefined);
    claimed = { ...savedSetup, harness: args.agent, models };
    args.reasoning ??= savedSetup.reasoning;
  } else {
    console.log(`${dim("→")} Claiming HallPass pairing code…`);
    claimed = await claimCode(args.code, {
      origin: args.origin,
      meta: claimMeta,
      expectedHarness: setup ? args.agent : undefined,
      harnesses: setup ? [args.agent] : !args.agent || args.agent === "all" ? detectedForAll : undefined,
      ...(fetcher ? { fetcher } : {}),
    });
    if (setup && claimed.harness !== args.agent && !claimed.tokensByHarness?.[args.agent]) {
      throw new Error(`This code belongs to ${cleanLog(claimed.harness)}. Generate a code for ${args.agent}.`);
    }
  }
  const targetHarness = args.agent || claimed.harness;
  const agents =
    targetHarness === "all" ? detectedForAll : [targetHarness];

  const configuredResults = [];

  try {
    const existingLogins = agents
      .filter((a) => a !== "cursor")
      .map((a) => ({ agent: a, ...detectExistingSubscription(a) }))
      .filter((x) => x.detected);

    let promptedMode = null;
    if (!args.mode && existingLogins.length > 0) {
      if (interactiveTty) {
        const names = existingLogins.map((x) => x.label).join(" & ");
        const rl = readline.createInterface({ input, output });
        try {
          console.log(`\n${bold(`Found existing ${names}.`)}`);
          console.log(dim("No files have been changed yet. How should HallPass connect?\n"));
          console.log(
            `  ${bold("[1]")} Keep existing logins untouched ${green("(Recommended)")}`,
          );
          console.log(
            dim("      Plain claude / codex stay on your current subscriptions."),
          );
          console.log(
            dim("      Launch HallPass via claude-hp, codex -p hallpass, or OpenCode /models.\n"),
          );
          console.log(
            `  ${bold("[2]")} Make HallPass the default`,
          );
          console.log(
            dim("      Updates your tool config (backs up originals; preserves hooks & MCPs)."),
          );
          console.log(
            dim("      Switch back anytime with `npx hallpassai pause` or `npx hallpassai uninstall`.\n"),
          );
          const ans = (await rl.question("Choice [1/2] (default 1): ")).trim();
          promptedMode = ans === "2" ? "default" : "coexist";
        } finally {
          rl.close();
        }
      } else {
        // Non-interactive safety: never silently overwrite an existing paid subscription login.
        promptedMode = "coexist";
      }
    }

    for (const agent of agents) {
      const hasSub = existingLogins.some((x) => x.agent === agent);
      const chosenMode = args.mode || (hasSub && promptedMode ? promptedMode : "default");

      const perAgentToken = claimed.tokensByHarness?.[agent] || claimed.token;
      const prior = setup && readStoredCredentials().keys[agent];
      if (prior && prior.mode !== "coexist" && !prior.paused && chosenMode === "coexist") {
        pauseAgent(agent);
      }
      const res = configureAgent(
        agent,
        { ...claimed, token: perAgentToken },
        {
          dryRun: false,
          reasoningEffort: args.reasoning,
          mode: chosenMode,
        },
      );
      configuredResults.push({ agent, res, token: perAgentToken });

      if (res.cursorValues) {
        await runCursorInteractive(res.cursorValues, {
          input,
          output,
          interactive: interactiveTty,
        });
      } else {
        const rNote = res.appliedReasoning
          ? dim(` (reasoning: ${cleanLog(res.appliedReasoning)})`)
          : "";
        const mNote = res.mode === "coexist" ? dim(" [coexist]") : "";
        console.log(
          `${green("✓")} Configured ${bold(cleanLog(agent))} → ${bold(cleanLog(res.appliedModel || claimed.model))}${rNote}${mNote}`,
        );
        for (const f of res.files) console.log(`  ${dim("updated")} ${f}`);
        if (res.backup) console.log(`  ${dim("backup")}  ${res.backup}`);
        if (setup) {
          if (chosenMode === "default") {
            console.log(`  New ${toolNames[agent]} chats use HallPass credits. Restore your default with \`hallpassai pause ${agent}\`.`);
          } else {
            console.log(`  Plain ${nativeCommand(agent)} keeps your current default.`);
          }
        } else printQuickControls(agent, res.appliedModel || claimed.model);
      }
      console.log(`\n${bold("Next:")} ${res.nextStep}`);
    }

    const reachable = Boolean(savedSetup) || await verifyGatewayReachable(
      claimed,
      fetcher ? { fetcher } : undefined,
    );
    if (reachable) {
      console.log(
        `${dim("✓ Verified gateway connection (0 credits used). Pause anytime with `npx hallpassai pause` · Cleanup with `npx hallpassai uninstall`.")}`,
      );
    }
    if (!savedSetup) await sendPairingStatus(
      {
        origin: claimed.resolvedOrigin,
        progressToken: claimed.progressToken,
        phase: "configured",
        meta: buildCliMeta({
          cliVersion: pkg.version,
          anonymousId: anonId,
          targetHarness,
          modelId: claimed.model,
          configuredHarnesses: agents,
          gatewayVerified: reachable,
        }),
      },
      fetcher ? { fetcher } : undefined,
    );

    const launchable =
      configuredResults.length === 1 &&
      configuredResults[0].agent !== "cursor"
        ? configuredResults[0]
        : null;
    if (
      launchable &&
      (args.launch === true ||
        (interactiveTty &&
          args.launch !== false &&
          !process.env.NODE_TEST_CONTEXT &&
          !input?.readableEnded))
    ) {
      let shouldLaunch = args.launch === true;
      if (!shouldLaunch) {
        const rl = readline.createInterface({ input, output });
        try {
          const ans = (
            await rl.question(
              `\n${bold(`Press Enter to launch ${cleanLog(launchable.agent)} on ${cleanLog(launchable.res.appliedModel || claimed.model)} now`)} ${dim("(first prompt unlocks +$9.00 free credit) [Y/n]: ")}`,
            )
          )
            .trim()
            .toLowerCase();
          shouldLaunch = !ans || ans === "y" || ans === "yes";
        } finally {
          rl.close();
        }
      }
      if (shouldLaunch) {
        const spec = buildEphemeralLaunchSpec(launchable.agent, {
          token: launchable.token,
          apiBase: claimed.apiBase,
          model: launchable.res.appliedModel || claimed.model,
          reasoning: launchable.res.appliedReasoning || args.reasoning || null,
          catalogModels: claimed.models || [],
          extraArgs: args.passThroughArgs,
        });
        const child = spawnSync(spec.command, spec.args, {
          stdio: "inherit",
          env: spec.env,
        });
        return child.status ?? 0;
      }
    }

    return 0;
  } catch (err) {
    if (!savedSetup) await sendPairingStatus(
      {
        origin: claimed.resolvedOrigin,
        progressToken: claimed.progressToken,
        phase: "error",
        errorCode: "cli_write_failed",
        meta: buildCliMeta({
          cliVersion: pkg.version,
          anonymousId: anonId,
          targetHarness,
        }),
      },
      fetcher ? { fetcher } : undefined,
    );
    throw err;
  }
}

if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(red(`✗ ${cleanLog(err?.message || err)}`));
      process.exitCode = 1;
    },
  );
}
