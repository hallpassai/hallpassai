#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
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
  console.log(`${bold("hallpassai")} v${pkg.version} — One-command setup for HallPass AI Gateway

${bold("Usage:")}
  npx hallpassai@latest <PAIRING-CODE> [--coexist] [--reasoning <level>]
  npx hallpassai@latest run [MODEL-ID] [--agent <name>] [-- <tool-args...>]
  npx hallpassai@latest add <MODEL-ID> [--agent <name>]
  npx hallpassai@latest use [MODEL-ID] [--reasoning <level>] [--agent <name>]
  npx hallpassai@latest pause | resume [--agent <name>]
  npx hallpassai@latest status | usage [--json]
  npx hallpassai@latest models [--provider <name>] [--search <query>]
  npx hallpassai@latest doctor
  npx hallpassai@latest undo [--agent <name>]
  npx hallpassai@latest uninstall [--agent <name>] [--keep-keys]

${bold("Options:")}
  --coexist              Keep existing subscription login intact (adds profile/shim/provider alongside)
  --mode <mode>          Explicit install mode: default or coexist
  --launch / --no-launch Auto-launch (or skip prompt to launch) tool after pairing
  -r, --reasoning <lvl>  Set reasoning depth (auto, none, minimal, low, medium, high, max, xhigh, ultra)
  -m, --model <id>       Explicit model ID for \`use\`, \`add\`, or \`run\`
  --agent <name>         Target a specific tool (${SUPPORTED_AGENTS.join(", ")})
  --provider <name>      Filter \`models\` list by provider (e.g. Anthropic, OpenAI, DeepSeek)
  --search <query>       Search \`models\` list by name or ID
  --json                 Output structured JSON for \`usage\` / \`status\`
  --dry-run              Preview configuration changes without claiming code or writing files
  --keep-keys            Keep server API keys active during uninstall (local cleanup only)
  --origin <url>         Override HallPass server origin
  -h, --help             Show help
  -v, --version          Show version
`);
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

function printQuickControls(agent, appliedModel) {
  if (agent === "cursor") return;
  const inToolSwitch =
    agent === "opencode" ? "`/models` (or `Ctrl+T` for reasoning)" : "`/model`";
  console.log(`  ${dim("in-session")} ${inToolSwitch} · ${dim("add model:")} \`npx hallpassai add ${cleanLog(appliedModel || "deepseek-v4.1-flash")}\` · ${dim("pause:")} \`npx hallpassai pause\``);
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
    json: false,
    dryRun: false,
    keepKeys: false,
    origin: null,
    passThroughArgs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.passThroughArgs = argv.slice(i + 1);
      break;
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
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (a === "--keep-keys") {
      out.keepKeys = true;
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
    if (a === "--agent") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --agent.");
      }
      out.agent = normalizeAgentName(next);
      continue;
    }
    if (a.startsWith("--agent=")) {
      out.agent = normalizeAgentName(a.slice(a.indexOf("=") + 1));
      if (!out.agent) throw new Error("Missing value for --agent.");
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
      throw new Error(`Unknown option: ${a}`);
    }
    if (!out.command) {
      if (UNINSTALL_ALIASES.has(a)) {
        out.command = "uninstall";
        continue;
      }
      if (
        [
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
          a === "model"
            ? "use"
            : a === "launch"
              ? "run"
              : a === "balance" || a === "credits"
                ? "usage"
                : a;
        continue;
      }
    }
    if (
      out.command === "run" &&
      !out.agent &&
      SUPPORTED_AGENTS.includes(normalizeAgentName(a))
    ) {
      out.agent = normalizeAgentName(a);
      continue;
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
    `\n${bold("Cursor setup (3 quick fields in Cursor → Settings → Models):")}`,
  );
  const isTty = isInteractiveTerminal({ input, output, interactive });
  const copiedKey = isTty ? copyToClipboard(values.apiKey) : false;
  console.log(
    `  1. ${bold("OpenAI API Key:")} ${cleanLog(values.apiKey.slice(0, 15))}•••••• ${copiedKey ? green("(✓ copied to clipboard)") : ""}`,
  );
  console.log(
    `  2. ${bold("Override OpenAI Base URL:")} ${cleanLog(values.baseUrl)}`,
  );
  console.log(`  3. ${bold("Model ID:")} ${cleanLog(values.model)}`);

  if (isTty) {
    const rl = readline.createInterface({ input, output });
    try {
      await rl.question(
        dim("\n  Press Enter after pasting the API key to copy the Base URL… "),
      );
      if (copyToClipboard(values.baseUrl))
        console.log(`  ${green("✓")} Copied Base URL: ${cleanLog(values.baseUrl)}`);
      await rl.question(
        dim("  Press Enter after pasting Base URL to copy the Model ID… "),
      );
      if (copyToClipboard(values.model))
        console.log(`  ${green("✓")} Copied Model ID: ${cleanLog(values.model)}`);
    } finally {
      rl.close();
    }
  }
}

export async function main(
  argv = process.argv.slice(2),
  { fetcher, input = process.stdin, output = process.stdout, interactive } = {},
) {
  const interactiveTty = isInteractiveTerminal({ input, output, interactive });
  const args = parseArgs(argv);
  if (args.command === "help") {
    printHelp();
    return 0;
  }
  if (args.command === "version") {
    console.log(pkg.version);
    return 0;
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
    const target = args.agent || "all";
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
      const paused = pauseAgent(target);
      console.log(
        `${green("✓")} Paused HallPass default routing${target === "all" ? "" : ` for ${bold(cleanLog(target))}`} (keys & credits preserved).`,
      );
      for (const item of paused) {
        console.log(`  ${dim("restored native default")} ${cleanLog(item.agent)}`);
      }
      console.log(dim("  Re-enable anytime with `npx hallpassai resume` or run once with `npx hallpassai run`."));
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
      return 0;
    }
    const catalogModels = await fetchCatalogDetails(
      { apiBase: first.apiBase, origin: args.origin },
      fetcher ? { fetcher } : undefined,
    );
    const resumed = resumeAgent(target, { catalogModels });
    for (const item of resumed) {
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
          `  ${dim("note")}    In Cursor → Settings → Models, toggle off Override OpenAI Base URL.`,
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
    const ledger = await fetchCliUsage(
      {
        origin: args.origin,
        apiBase: first?.apiBase,
        token: first?.token,
        limit: 15,
      },
      fetcher ? { fetcher } : undefined,
    );

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

  const isModelCompatibleWithAgent = (agent, modelObj, catalogList = []) => {
    if (!modelObj) return true;
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
    if (agent === "codex") {
      const hasNativeOpenAi = catalogList.some(
        (m) =>
          m.protocols?.includes("responses") &&
          (m.provider === "OpenAI" ||
            /^(?:gpt-|openai-gpt-|o[134]|codex)/i.test(m.id)),
      );
      if (
        hasNativeOpenAi &&
        modelObj.provider !== "OpenAI" &&
        !/^(?:gpt-|openai-gpt-|o[134]|codex)/i.test(modelObj.id)
      ) {
        return false;
      }
    }
    return true;
  };

  if (args.command === "add") {
    if (!validateAgentFlag()) return 1;
    if (!args.modelArg || !isValidModelId(args.modelArg)) {
      console.error(
        red("Provide a model ID to add (e.g. `npx hallpassai add gpt-6.1-sol`)."),
      );
      return 1;
    }
    const creds = readStoredCredentials();
    const targets =
      args.agent && args.agent !== "all"
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
    const catalogModels = await fetchCatalogDetails(
      { apiBase: first?.apiBase, origin: args.origin },
      fetcher ? { fetcher } : undefined,
    );
    const catalogMatch = catalogModels.length
      ? catalogModels.find((m) => m.id === args.modelArg)
      : null;
    if (catalogModels.length && !catalogMatch) {
      console.error(
        red(
          `Unknown model "${cleanLog(args.modelArg)}". Run \`npx hallpassai models\` to browse available models.`,
        ),
      );
      return 1;
    }
    const addedTo = [];
    for (const agent of targets) {
      if (catalogMatch && !isModelCompatibleWithAgent(agent, catalogMatch, catalogModels)) {
        if (targets.length === 1) {
          console.error(
            red(`Model "${cleanLog(args.modelArg)}" is not supported by ${cleanLog(agent)}.`),
          );
          return 1;
        }
        continue;
      }
      const res = addModelToAgent(agent, args.modelArg, { catalogModels });
      addedTo.push(agent);
      console.log(
        `${green("✓")} Added ${bold(cleanLog(res.model))} to ${bold(cleanLog(agent))}`,
      );
      for (const f of res.files) console.log(`  ${dim("updated")} ${f}`);
      if (res.hint) console.log(`  ${dim("tip")}     ${res.hint}`);
    }
    if (!addedTo.length) {
      console.error(
        red(`No configured tool on this machine supports "${cleanLog(args.modelArg)}".`),
      );
      return 1;
    }
    if (!telemetryDisabled()) {
      await sendCliEvent(
        "cli_model_added",
        {
          origin: args.origin,
          apiBase: first?.apiBase,
          token: first?.token,
          meta: buildCliMeta({
            cliVersion: pkg.version,
            anonymousId: getAnonymousId(),
            modelId: args.modelArg,
            configuredHarnesses: addedTo,
          }),
        },
        fetcher ? { fetcher } : undefined,
      );
    }
    return 0;
  }

  if (args.command === "run") {
    if (!validateAgentFlag()) return 1;
    const creds = readStoredCredentials();
    const configuredAgents = Object.keys(creds.keys || {}).filter(
      (k) => k !== "cursor",
    );
    if (!configuredAgents.length) {
      console.error(
        red(
          "No HallPass CLI credentials found. Pair first at https://app.hallpassai.com/start.html#connect",
        ),
      );
      return 1;
    }
    const first = creds.keys[configuredAgents[0]];
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
    const entry = creds.keys[chosenAgent] || first;
    const chosenModel = args.modelArg || entry.model;
    const chosenReasoning = args.reasoning || entry.reasoning || null;
    const spec = buildEphemeralLaunchSpec(chosenAgent, {
      token: entry.token,
      apiBase: entry.apiBase,
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
    const launched = spawnSync(spec.command, spec.args, {
      stdio: "inherit",
      env: spec.env,
    });
    if (launched.error) {
      console.error(red(`Could not launch ${cleanLog(chosenAgent)}: ${cleanLog(launched.error.message)}`));
      return 1;
    }
    return launched.status ?? 0;
  }

  if (args.command === "models") {
    if (!validateAgentFlag()) return 1;
    const creds = readStoredCredentials();
    const first = Object.values(creds.keys || {})[0];
    const detailed = await fetchCatalogDetails(
      {
        apiBase: first?.apiBase || null,
        origin: args.origin || (!first?.apiBase ? resolveOrigin("HP") : null),
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

    const catalogMatch =
      chosenModel && catalogModels.length
        ? catalogModels.find((m) => m.id === chosenModel)
        : null;
    if (chosenModel && catalogModels.length && !catalogMatch) {
      const suggestions = catalogModels
        .filter((m) => m.id.includes(chosenModel.toLowerCase()))
        .slice(0, 4)
        .map((m) => m.id);
      console.error(
        red(
          `Unknown model "${cleanLog(chosenModel)}".${suggestions.length ? ` Did you mean: ${suggestions.map(cleanLog).join(", ")}?` : " Run `npx hallpassai models` to browse available models."}`,
        ),
      );
      return 1;
    }

    const inferOfflineCompatible = (agent, modelId) => {
      if (agent === "codex")
        return /^(?:gpt-|openai-gpt-|o[134]\b|o[134]-|codex)/i.test(modelId);
      return true;
    };

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

  const parsedCode = args.code ? normalizeCode(args.code) : null;
  if (!parsedCode) {
    console.error(
      red("Please provide a valid pairing code (e.g. `npx hallpassai HP-XXXX-XXXX`)."),
    );
    return 1;
  }
  if (!validateAgentFlag()) return 1;

  if (args.dryRun) {
    const resolvedOrigin = resolveOrigin(parsedCode.prefix, args.origin);
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
      `${dim("→")} Previewing HallPass setup (pairing code ${parsedCode.code} NOT consumed)…`,
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

  console.log(`${dim("→")} Claiming HallPass pairing code…`);
  const claimed = await claimCode(args.code, {
    origin: args.origin,
    meta: claimMeta,
    harnesses: !args.agent || args.agent === "all" ? detectedForAll : undefined,
    ...(fetcher ? { fetcher } : {}),
  });
  const targetHarness = args.agent || claimed.harness;
  const agents =
    targetHarness === "all" ? detectedForAll : [targetHarness];

  const configuredResults = [];

  try {
    for (const agent of agents) {
      let chosenMode = args.mode || "default";
      if (!args.mode && interactiveTty && agent !== "cursor") {
        const sub = detectExistingSubscription(agent);
        if (sub.detected) {
          const rl = readline.createInterface({ input, output });
          try {
            console.log(`\n${bold(`Existing ${sub.label} detected:`)}`);
            console.log(
              `  ${bold("[1]")} Keep my existing login & add HallPass alongside ${green("(Recommended)")}`,
            );
            console.log(
              `  ${bold("[2]")} Use HallPass as default for ${cleanLog(agent)} ${dim("(pause anytime with `npx hallpassai pause`)")}`,
            );
            const ans = (await rl.question("Choose [1/2] (default 1): ")).trim();
            chosenMode = ans === "2" ? "default" : "coexist";
          } finally {
            rl.close();
          }
        }
      }

      const perAgentToken = claimed.tokensByHarness?.[agent] || claimed.token;
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
        printQuickControls(agent, res.appliedModel || claimed.model);
      }
      console.log(`\n${bold("Next:")} ${res.nextStep}`);
    }

    const reachable = await verifyGatewayReachable(
      claimed,
      fetcher ? { fetcher } : undefined,
    );
    if (reachable) {
      console.log(
        `${dim("✓ Verified gateway connection (0 credits used). Pause anytime with `npx hallpassai pause` · Cleanup with `npx hallpassai uninstall`.")}`,
      );
    }
    await sendPairingStatus(
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
    if (launchable && (args.launch === true || (interactiveTty && args.launch !== false))) {
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
    await sendPairingStatus(
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
