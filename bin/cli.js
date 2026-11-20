#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  SUPPORTED_AGENTS,
  VALID_REASONING_LEVELS,
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
  isValidModelId,
  claimCode,
  fetchLiveModels,
  fetchCatalogDetails,
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
  npx hallpassai@latest <PAIRING-CODE> [--reasoning <level>]
  npx hallpassai@latest models [--provider <name>] [--search <query>]
  npx hallpassai@latest use [MODEL-ID] [--reasoning <level>] [--agent <name>]
  npx hallpassai@latest status | doctor
  npx hallpassai@latest undo [--agent <name>]
  npx hallpassai@latest uninstall [--agent <name>] [--keep-keys]

${bold("Options:")}
  -r, --reasoning <lvl>  Set reasoning depth (auto, none, minimal, low, medium, high, max, xhigh)
  -m, --model <id>       Explicit model ID for \`use\`
  --agent <name>         Target a specific tool (${SUPPORTED_AGENTS.join(", ")})
  --provider <name>      Filter \`models\` list by provider (e.g. Anthropic, OpenAI, DeepSeek)
  --search <query>       Search \`models\` list by name or ID
  --dry-run              Preview configuration changes without claiming code or writing files
  --keep-keys            Keep server API keys active during uninstall (local cleanup only)
  --origin <url>         Override HallPass server origin
  -h, --help             Show help
  -v, --version          Show version
`);
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
      out.agent = a.slice(a.indexOf("=") + 1);
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
    if (out.command === "models") {
      out.search = out.search ? `${out.search} ${a}` : a;
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
  if (args.reasoning && !VALID_REASONING_LEVELS.has(args.reasoning)) {
    console.error(
      red(
        `Invalid --reasoning "${cleanLog(args.reasoning)}". Choose one of: auto, none, minimal, low, medium, high, max, xhigh`,
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
    if (!validateAgentFlag()) return 1;
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
      const activeModel = disk.diskModel || info.model;
      const activeReasoning = disk.diskReasoning ?? info.reasoning ?? null;
      const modelOk =
        !live.models.length || live.models.includes(activeModel);
      const healthy = live.ok && disk.ok && modelOk;
      if (!healthy) allHealthy = false;
      const reasoningBadge = activeReasoning
        ? ` · reasoning: ${cleanLog(activeReasoning)}`
        : "";
      console.log(
        `${healthy ? green("✓") : red("✗")} ${bold(cleanLog(agent))} — model: ${cleanLog(activeModel)}${reasoningBadge} · endpoint: ${cleanLog(info.apiBase)} · key: ${live.ok ? `active (${live.latencyMs}ms)` : "invalid or unreachable"}`,
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
    if (agent === "claude-code") {
      const hasNativeClaude = catalogList.some(
        (m) =>
          m.protocols?.includes("messages") &&
          (m.provider === "Anthropic" || /^claude[-_]/i.test(m.id)),
      );
      if (
        hasNativeClaude &&
        modelObj.provider !== "Anthropic" &&
        !/^claude[-_]/i.test(modelObj.id)
      ) {
        return false;
      }
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
        const tags = [m.reasoning ? "reasoning" : "", ctx]
          .filter(Boolean)
          .join(", ");
        console.log(
          `    • ${cleanLog(m.id)}${m.name && m.name !== m.id ? dim(` (${cleanLog(m.name)})`) : ""}${tags ? dim(` [${tags}]`) : ""}`,
        );
      }
    }
    console.log(
      dim(
        "\nSwitch models & reasoning anytime: `npx hallpassai use <model-id> --reasoning high`",
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

    // Interactive TTY picker when `npx hallpassai use` is invoked with neither model nor --reasoning
    if (
      !chosenModel &&
      !chosenReasoning &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
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
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
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
                  `Invalid reasoning effort "${cleanLog(rAns)}". Choose auto, none, minimal, low, medium, high, max, or xhigh.`,
                ),
              );
              return 1;
            }
            chosenReasoning = rAns;
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
      if (agent === "claude-code") return /^claude[-_]/i.test(modelId);
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
      });
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
      const res = configureAgent(agent, claimed, {
        dryRun: false,
        reasoningEffort: args.reasoning,
      });
      if (res.cursorValues) {
        await runCursorInteractive(res.cursorValues);
      } else {
        const rNote = res.appliedReasoning
          ? dim(` (reasoning: ${cleanLog(res.appliedReasoning)})`)
          : "";
        console.log(
          `${green("✓")} Configured ${bold(cleanLog(agent))} → ${bold(cleanLog(res.appliedModel || claimed.model))}${rNote}`,
        );
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
