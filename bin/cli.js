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
  copyToClipboard,
} from "../src/adapters.js";
import {
  normalizeCode,
  claimCode,
  verifyGatewayReachable,
  sendPairingStatus,
} from "../src/client.js";
import { readStoredCredentials } from "../src/secrets.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const green = (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);

function printHelp() {
  console.log(`${bold("hallpassai")} v${pkg.version} — One-command setup for HallPass AI Gateway

${bold("Usage:")}
  npx hallpassai@latest <PAIRING-CODE> [options]
  npx hallpassai@latest status
  npx hallpassai@latest undo [--agent <name>]

${bold("Options:")}
  --agent <name>   Override target tool (${SUPPORTED_AGENTS.join(", ")})
  --dry-run        Preview configuration changes without writing files
  --origin <url>   Override HallPass server origin
  -h, --help       Show help
  -v, --version    Show version
`);
}

function parseArgs(argv) {
  const out = { command: null, code: null, agent: null, dryRun: false, origin: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help" || a === "help") {
      out.command = "help";
      return out;
    }
    if (a === "-v" || a === "--version") {
      out.command = "version";
      return out;
    }
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (a === "--agent" && argv[i + 1]) {
      out.agent = argv[++i];
      continue;
    }
    if (a.startsWith("--agent=")) {
      out.agent = a.slice(8);
      continue;
    }
    if (a === "--origin" && argv[i + 1]) {
      out.origin = argv[++i];
      continue;
    }
    if (a.startsWith("--origin=")) {
      out.origin = a.slice(9);
      continue;
    }
    if (!out.command && ["connect", "pair", "status", "undo"].includes(a)) {
      out.command = a;
      continue;
    }
    if (!out.code) out.code = a;
  }
  if (!out.command) out.command = out.code ? "connect" : "help";
  return out;
}

async function runCursorInteractive(values) {
  console.log(`\n${bold("Cursor setup (3 quick fields in Cursor → Settings → Models):")}`);
  const copiedKey = copyToClipboard(values.apiKey);
  console.log(
    `  1. ${bold("OpenAI API Key:")} ${values.apiKey.slice(0, 15)}•••••• ${copiedKey ? green("(✓ copied to clipboard)") : ""}`,
  );
  console.log(`  2. ${bold("Override OpenAI Base URL:")} ${values.baseUrl}`);
  console.log(`  3. ${bold("Model ID:")} ${values.model}`);

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      await rl.question(
        dim("\n  Press Enter after pasting the API key to copy the Base URL… "),
      );
      if (copyToClipboard(values.baseUrl))
        console.log(`  ${green("✓")} Copied Base URL: ${values.baseUrl}`);
      await rl.question(
        dim("  Press Enter after pasting Base URL to copy the Model ID… "),
      );
      if (copyToClipboard(values.model))
        console.log(`  ${green("✓")} Copied Model ID: ${values.model}`);
    } finally {
      rl.close();
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === "help") {
    printHelp();
    return 0;
  }
  if (args.command === "version") {
    console.log(pkg.version);
    return 0;
  }
  if (args.command === "undo") {
    if (args.agent && args.agent !== "all" && !SUPPORTED_AGENTS.includes(args.agent)) {
      console.error(red(`Unknown agent: ${args.agent}`));
      return 1;
    }
    const restored = undoAgent(args.agent || "all");
    console.log(
      restored.length
        ? `${green("✓")} Restored ${restored.length} file(s):\n  ${restored.join("\n  ")}`
        : `${green("✓")} HallPass credentials cleared.`,
    );
    return 0;
  }
  if (args.command === "status") {
    const creds = readStoredCredentials();
    const entries = Object.entries(creds.keys || {});
    if (!entries.length) {
      console.log("No HallPass tools configured on this machine yet.");
      console.log("Generate a pairing code at https://app.hallpassai.com/start.html#connect");
      return 0;
    }
    for (const [agent, info] of entries) {
      const ok = await verifyGatewayReachable({
        apiBase: info.apiBase,
        token: info.token,
      });
      console.log(
        `${ok ? green("✓") : red("✗")} ${bold(agent)} — model: ${info.model} · endpoint: ${info.apiBase} · key: ${ok ? "active" : "invalid or unreachable"}`,
      );
    }
    return 0;
  }

  if (!args.code || !normalizeCode(args.code)) {
    console.error(
      red("Please provide a valid pairing code (e.g. `npx hallpassai HP-XXXX-XXXX`)."),
    );
    return 1;
  }
  if (args.agent && args.agent !== "all" && !SUPPORTED_AGENTS.includes(args.agent)) {
    console.error(
      red(`Unsupported --agent "${args.agent}". Choose one of: ${SUPPORTED_AGENTS.join(", ")}`),
    );
    return 1;
  }

  console.log(`${dim("→")} Claiming HallPass pairing code…`);
  const claimed = await claimCode(args.code, { origin: args.origin });
  const targetHarness = args.agent || claimed.harness;
  const agents =
    targetHarness === "all" ? detectInstalledAgents() : [targetHarness];

  try {
    for (const agent of agents) {
      const res = configureAgent(agent, claimed, { dryRun: args.dryRun });
      if (args.dryRun) {
        console.log(`\n${bold(`[dry-run] ${agent}`)} (${res.files.join(", ")}):`);
        if (res.preview) console.log(res.preview);
        continue;
      }
      if (res.cursorValues) {
        await runCursorInteractive(res.cursorValues);
      } else {
        console.log(`${green("✓")} Configured ${bold(agent)}`);
        for (const f of res.files) console.log(`  ${dim("updated")} ${f}`);
        if (res.backup) console.log(`  ${dim("backup")}  ${res.backup}`);
      }
      console.log(`\n${bold("Next:")} ${res.nextStep}`);
    }

    if (!args.dryRun) {
      const reachable = await verifyGatewayReachable(claimed);
      if (reachable) {
        console.log(
          `${dim("✓ Verified gateway connection (0 credits used). Undo anytime with `npx hallpassai undo`.")}`,
        );
      }
      await sendPairingStatus({
        origin: claimed.resolvedOrigin,
        progressToken: claimed.progressToken,
        phase: "configured",
      });
    }
    return 0;
  } catch (err) {
    await sendPairingStatus({
      origin: claimed.resolvedOrigin,
      progressToken: claimed.progressToken,
      phase: "error",
      errorCode: "cli_write_failed",
    });
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
      console.error(red(`✗ ${err.message || err}`));
      process.exitCode = 1;
    },
  );
}
