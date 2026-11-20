#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  SUPPORTED_AGENTS,
  detectInstalledAgents,
  configureAgent,
  undoAgent,
  inspectAgentConfig,
  switchAgentModel,
  copyToClipboard,
} from "../src/adapters.js";
import {
  normalizeCode,
  resolveOrigin,
  claimCode,
  fetchLiveModels,
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

function printHelp() {
  console.log(`${bold("hallpassai")} v${pkg.version} — One-command setup for HallPass AI Gateway

${bold("Usage:")}
  npx hallpassai@latest <PAIRING-CODE> [options]
  npx hallpassai@latest status
  npx hallpassai@latest doctor
  npx hallpassai@latest models
  npx hallpassai@latest use <MODEL-ID> [--agent <name>]
  npx hallpassai@latest undo [--agent <name>]
  npx hallpassai@latest uninstall [--agent <name>] [--keep-keys]

${bold("Options:")}
  --agent <name>   Target a specific tool (${SUPPORTED_AGENTS.join(", ")})
  --dry-run        Preview configuration changes without claiming code or writing files
  --keep-keys      Keep server API keys active during uninstall (local cleanup only)
  --origin <url>   Override HallPass server origin
  -h, --help       Show help
  -v, --version    Show version
`);
}

export function parseArgs(argv) {
  const out = {
    command: null,
    code: null,
    modelArg: null,
    agent: null,
    dryRun: false,
    keepKeys: false,
    origin: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help" || a === "help") {
      out.command = "help";
      return out;
    }
    if (a === "-v" || a === "--version" || a === "version") {
      out.command = "version";
      return out;
    }
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (a === "--keep-keys") {
      out.keepKeys = true;
      continue;
    }
    if (a === "--agent") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --agent.");
      }
      out.agent = next;
      continue;
    }
    if (a.startsWith("--agent=")) {
      out.agent = a.slice(8);
      if (!out.agent) throw new Error("Missing value for --agent.");
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
      out.origin = a.slice(9);
      if (!out.origin) throw new Error("Missing value for --origin.");
      continue;
    }
    if (!out.command) {
      if (UNINSTALL_ALIASES.has(a)) {
        out.command = "uninstall";
        continue;
      }
      if (
        ["connect", "pair", "status", "doctor", "undo", "models", "use", "model"].includes(a)
      ) {
        out.command = a === "model" ? "use" : a;
        continue;
      }
    }
    if (out.command === "use" && !out.modelArg) {
      out.modelArg = a;
      continue;
    }
    if (!out.code) out.code = a;
  }
  if (!out.command) out.command = out.code ? "connect" : "help";
  return out;
}

async function runCursorInteractive(values) {
  console.log(
    `\n${bold("Cursor setup (3 quick fields in Cursor → Settings → Models):")}`,
  );
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const copiedKey = interactive ? copyToClipboard(values.apiKey) : false;
  console.log(
    `  1. ${bold("OpenAI API Key:")} ${cleanLog(values.apiKey.slice(0, 15))}•••••• ${copiedKey ? green("(✓ copied to clipboard)") : ""}`,
  );
  console.log(
    `  2. ${bold("Override OpenAI Base URL:")} ${cleanLog(values.baseUrl)}`,
  );
  console.log(`  3. ${bold("Model ID:")} ${cleanLog(values.model)}`);

  if (interactive) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
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

export async function main(argv = process.argv.slice(2), { fetcher } = {}) {
  const args = parseArgs(argv);
  if (args.command === "help") {
    printHelp();
    return 0;
  }
  if (args.command === "version") {
    console.log(pkg.version);
    return 0;
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

  if (args.command === "undo" || args.command === "uninstall") {
    if (!validateAgentFlag()) return 1;
    const target = args.agent || "all";
    const isUninstall = args.command === "uninstall";
    const creds = readStoredCredentials();
    const anonId = !telemetryDisabled() ? getAnonymousId() : undefined;
    const matchingEntries = Object.entries(creds.keys || {}).filter(
      ([k]) => target === "all" || k === target,
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

  if (args.command === "status" || args.command === "doctor") {
    const creds = readStoredCredentials();
    const entries = Object.entries(creds.keys || {}).filter(
      ([k]) => !args.agent || args.agent === "all" || k === args.agent,
    );
    const anonId = !telemetryDisabled() ? getAnonymousId() : undefined;
    if (!entries.length) {
      console.log("No HallPass tools configured on this machine yet.");
      console.log(
        "Generate a pairing code at https://app.hallpassai.com/start.html#connect",
      );
      return 0;
    }
    let allHealthy = true;
    for (const [agent, info] of entries) {
      const live = await fetchLiveModels(
        { apiBase: info.apiBase, token: info.token },
        fetcher ? { fetcher } : undefined,
      );
      const disk = inspectAgentConfig(agent);
      const modelOk =
        !live.models.length || live.models.includes(info.model);
      const healthy = live.ok && disk.ok && modelOk;
      if (!healthy) allHealthy = false;
      console.log(
        `${healthy ? green("✓") : red("✗")} ${bold(cleanLog(agent))} — model: ${cleanLog(info.model)} · endpoint: ${cleanLog(info.apiBase)} · key: ${live.ok ? `active (${live.latencyMs}ms)` : "invalid or unreachable"}`,
      );
      if (args.command === "doctor" || !disk.ok || !modelOk) {
        console.log(
          `  ${dim("config")}  ${disk.ok ? "ok" : "drift detected"} — ${cleanLog(disk.note)}`,
        );
        console.log(`  ${dim("endpoint")} ${cleanLog(info.apiBase)}`);
        if (live.ok && !modelOk) {
          console.log(
            `  ${dim("warning")} Model "${cleanLog(info.model)}" not in live catalog (${live.models.slice(0, 4).map(cleanLog).join(", ")}). Switch with \`npx hallpassai use <model>\`.`,
          );
        }
      }
    }
    if (!telemetryDisabled()) {
      const first = entries[0][1];
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

  if (args.command === "models") {
    const creds = readStoredCredentials();
    const first = Object.values(creds.keys || {})[0];
    if (!first?.token || !first?.apiBase) {
      console.error(
        red(
          "No active HallPass tool configured yet. Pair first at https://app.hallpassai.com/start.html#connect",
        ),
      );
      return 1;
    }
    const live = await fetchLiveModels(
      { apiBase: first.apiBase, token: first.token },
      fetcher ? { fetcher } : undefined,
    );
    if (!live.ok) {
      console.error(red("Could not reach HallPass gateway with stored key."));
      return 1;
    }
    console.log(`${bold(`Available models (${live.models.length}):`)}`);
    for (const m of live.models) console.log(`  • ${cleanLog(m)}`);
    console.log(
      dim("\nSwitch models anytime with `npx hallpassai use <model-id>`."),
    );
    return 0;
  }

  if (args.command === "use") {
    if (!validateAgentFlag()) return 1;
    if (!args.modelArg || !/^[A-Za-z0-9._:/-]{1,128}$/.test(args.modelArg)) {
      console.error(
        red("Provide a valid model ID (e.g. `npx hallpassai use claude-sonnet-4-6`)."),
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
    for (const agent of targets) {
      const res = switchAgentModel(agent, args.modelArg);
      console.log(
        `${green("✓")} Updated ${bold(cleanLog(agent))} → model ${bold(cleanLog(args.modelArg))}`,
      );
      for (const f of res.files) console.log(`  ${dim("updated")} ${f}`);
    }
    if (!telemetryDisabled()) {
      const first = creds.keys[targets[0]];
      await sendCliEvent(
        "cli_model_switched",
        {
          origin: args.origin,
          apiBase: first?.apiBase,
          token: first?.token,
          meta: buildCliMeta({
            cliVersion: pkg.version,
            anonymousId: getAnonymousId(),
            modelId: args.modelArg,
            configuredHarnesses: targets,
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

  // Dry-run previews local adapter output WITHOUT consuming the single-use server pairing code or rotating live keys.
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
          protocols: ["messages", "chat/completions"],
        },
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          protocols: ["responses", "chat/completions"],
        },
      ],
    };
    console.log(
      `${dim("→")} Previewing HallPass setup (pairing code ${parsedCode.code} NOT consumed)…`,
    );
    for (const agent of agents) {
      const res = configureAgent(agent, previewPayload, { dryRun: true });
      console.log(
        `\n${bold(`[dry-run] ${agent}`)}${res.files.length ? ` (${res.files.join(", ")})` : ""}:`,
      );
      if (res.preview) console.log(res.preview);
    }
    return 0;
  }

  const anonId = !telemetryDisabled() ? getAnonymousId() : undefined;
  const claimMeta = buildCliMeta({
    cliVersion: pkg.version,
    anonymousId: anonId,
    targetHarness: args.agent || undefined,
  });

  console.log(`${dim("→")} Claiming HallPass pairing code…`);
  const claimed = await claimCode(args.code, {
    origin: args.origin,
    meta: claimMeta,
    ...(fetcher ? { fetcher } : {}),
  });
  const targetHarness = args.agent || claimed.harness;
  const agents =
    targetHarness === "all" ? detectInstalledAgents() : [targetHarness];

  try {
    for (const agent of agents) {
      const res = configureAgent(agent, claimed, { dryRun: false });
      if (res.cursorValues) {
        await runCursorInteractive(res.cursorValues);
      } else {
        console.log(`${green("✓")} Configured ${bold(cleanLog(agent))}`);
        for (const f of res.files) console.log(`  ${dim("updated")} ${f}`);
        if (res.backup) console.log(`  ${dim("backup")}  ${res.backup}`);
      }
      console.log(`\n${bold("Next:")} ${res.nextStep}`);
    }

    const reachable = await verifyGatewayReachable(
      claimed,
      fetcher ? { fetcher } : undefined,
    );
    if (reachable) {
      console.log(
        `${dim("✓ Verified gateway connection (0 credits used). Cleanup anytime with `npx hallpassai uninstall`.")}`,
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
