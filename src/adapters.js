import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  assertNotSymlink,
  hallpassDir,
  helperScriptPath,
  readStoredCredentials,
  storeCredential,
  removeCredential,
  purgeHallpassDir,
  writePrivateFile,
} from "./secrets.js";

export const SUPPORTED_AGENTS = [
  "claude-code",
  "codex",
  "opencode",
  "copilot",
  "cursor",
];

const TOML_HEADER_RE = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;

function backupOnce(filePath, { secret = false } = {}) {
  if (!fs.existsSync(filePath)) return null;
  assertNotSymlink(filePath);
  const bak = `${filePath}.hallpass.bak`;
  if (!fs.existsSync(bak)) {
    assertNotSymlink(bak);
    const stat = fs.statSync(filePath);
    const mode = secret ? 0o600 : stat.mode & 0o777 || 0o600;
    const raw = fs.readFileSync(filePath);
    writePrivateFile(bak, raw, mode);
  }
  return bak;
}

export function stripJsonc(raw) {
  let noComments = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];
    if (inStr) {
      noComments += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      noComments += c;
    } else if (c === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      if (i < raw.length) noComments += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
    } else {
      noComments += c;
    }
  }
  // Strip trailing commas ONLY outside string literals.
  let out = "";
  inStr = false;
  esc = false;
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === "}" || noComments[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  assertNotSymlink(filePath);
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(stripJsonc(raw));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed;
}

function previousStatePath(homeDir = os.homedir()) {
  return path.join(hallpassDir(homeDir), "previous-state.json");
}

function readPreviousState(homeDir = os.homedir()) {
  try {
    return readJsonSafe(previousStatePath(homeDir));
  } catch {
    return {};
  }
}

function savePreviousAgentState(agent, patch, homeDir = os.homedir()) {
  const cur = readPreviousState(homeDir);
  if (!cur[agent]) {
    cur[agent] = patch;
    writePrivateFile(
      previousStatePath(homeDir),
      JSON.stringify(cur, null, 2) + "\n",
      0o600,
    );
  }
}

function clearPreviousAgentState(agent, homeDir = os.homedir()) {
  const fp = previousStatePath(homeDir);
  if (!fs.existsSync(fp)) return;
  const cur = readPreviousState(homeDir);
  if (agent === "all") {
    assertNotSymlink(fp);
    fs.unlinkSync(fp);
    return;
  }
  delete cur[agent];
  if (Object.keys(cur).length === 0) {
    assertNotSymlink(fp);
    fs.unlinkSync(fp);
  } else {
    writePrivateFile(fp, JSON.stringify(cur, null, 2) + "\n", 0o600);
  }
}

function resolveCodexDir(homeDir = os.homedir(), env = process.env) {
  const useEnv = homeDir === os.homedir();
  if (useEnv && env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME)) {
    return path.resolve(env.CODEX_HOME);
  }
  return path.join(path.resolve(homeDir), ".codex");
}

function resolveOpencodeDirs(homeDir, env = process.env) {
  const useEnvXdg = homeDir === os.homedir();
  const configDir =
    useEnvXdg && env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
      ? path.join(path.resolve(env.XDG_CONFIG_HOME), "opencode")
      : path.join(path.resolve(homeDir), ".config", "opencode");
  const dataDir =
    useEnvXdg && env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
      ? path.join(path.resolve(env.XDG_DATA_HOME), "opencode")
      : path.join(path.resolve(homeDir), ".local", "share", "opencode");
  return { configDir, dataDir };
}

export function detectInstalledAgents(homeDir = os.homedir(), env = process.env) {
  const found = [];
  const hasCmd = (cmd) => {
    const res = spawnSync(
      process.platform === "win32" ? "where" : "which",
      [cmd],
      { stdio: "ignore", env, timeout: 3000 },
    );
    return res.status === 0;
  };
  if (fs.existsSync(path.join(homeDir, ".claude")) || hasCmd("claude"))
    found.push("claude-code");
  if (fs.existsSync(path.join(homeDir, ".codex")) || hasCmd("codex"))
    found.push("codex");
  if (
    fs.existsSync(resolveOpencodeDirs(homeDir, env).configDir) ||
    fs.existsSync(path.join(homeDir, ".config", "opencode")) ||
    hasCmd("opencode")
  )
    found.push("opencode");
  if (hasCmd("copilot")) found.push("copilot");
  return found.length ? found : ["claude-code"];
}

export function detectExistingSubscription(agent, homeDir = os.homedir()) {
  try {
    if (agent === "claude-code") {
      const credsFile = path.join(homeDir, ".claude", ".credentials.json");
      if (fs.existsSync(credsFile)) {
        const j = readJsonSafe(credsFile);
        if (Object.keys(j).length > 0) {
          return { detected: true, label: "Claude login" };
        }
      }
      const rootClaude = path.join(homeDir, ".claude.json");
      if (fs.existsSync(rootClaude)) {
        const j = readJsonSafe(rootClaude);
        if (j?.oauthAccount || j?.primaryApiKey) {
          return { detected: true, label: "Claude login" };
        }
      }
    } else if (agent === "codex") {
      const authFile = path.join(homeDir, ".codex", "auth.json");
      if (fs.existsSync(authFile)) {
        const j = readJsonSafe(authFile);
        if (j?.tokens || j?.OPENAI_API_KEY) {
          return { detected: true, label: "Codex / ChatGPT login" };
        }
      }
    } else if (agent === "opencode") {
      const { dataDir } = resolveOpencodeDirs(homeDir);
      const authFile = path.join(dataDir, "auth.json");
      if (fs.existsSync(authFile)) {
        const j = readJsonSafe(authFile);
        if (Object.keys(j).some((k) => k !== "hallpass")) {
          return { detected: true, label: "OpenCode provider login" };
        }
      }
    } else if (agent === "copilot") {
      const ghHosts = path.join(homeDir, ".config", "github-copilot", "hosts.json");
      const cpCfg = path.join(homeDir, ".copilot", "config.json");
      if (fs.existsSync(ghHosts) || fs.existsSync(cpCfg)) {
        return { detected: true, label: "GitHub Copilot login" };
      }
    }
  } catch {}
  return { detected: false, label: "" };
}

export function resolveRealBinary(cmd, env = process.env, homeDir = os.homedir()) {
  const shimDir = path.resolve(path.join(hallpassDir(homeDir), "bin"));
  const pathSep = process.platform === "win32" ? ";" : ":";
  const dirs = String(env.PATH || "")
    .split(pathSep)
    .filter(Boolean);
  const candidates = [];
  for (const d of dirs) {
    // Reject relative PATH entries (e.g. `.` or `node_modules/.bin`) to prevent CWD binary hijacking.
    if (!path.isAbsolute(d)) continue;
    const resolvedDir = path.resolve(d);
    if (resolvedDir === shimDir) continue;
    const full = path.join(resolvedDir, process.platform === "win32" ? `${cmd}.cmd` : cmd);
    const plain = path.join(resolvedDir, cmd);
    for (const p of process.platform === "win32" ? [full, plain] : [plain]) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) candidates.push(path.resolve(p));
      } catch {}
    }
  }
  // Prefer native binary if an earlier ~/.local/bin entry is a codex-wallet wrapper script
  if (cmd === "codex" && candidates.length > 1) {
    const nonWallet = candidates.find((p) => {
      try {
        const target = fs.realpathSync(p);
        return !target.includes("wallet-shim");
      } catch {
        return true;
      }
    });
    if (nonWallet) return nonWallet;
  }
  return candidates[0] || cmd;
}

function writeShimScript(homeDir, shimName, lines) {
  const shimsDir = path.join(hallpassDir(homeDir), "bin");
  const shimPath = path.join(shimsDir, shimName);
  const content = ["#!/bin/sh", ...lines, ""].join("\n");
  writePrivateFile(shimPath, content, 0o700);
  return shimPath;
}

function tomlBasicString(val) {
  const s = String(val);
  if (s.includes("\u0000")) {
    throw new Error("NUL byte not allowed in TOML string.");
  }
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0xd800 && cp <= 0xdfff)) {
      throw new Error(
        `Disallowed character U+${cp.toString(16).toUpperCase()} in TOML value.`,
      );
    } else {
      out += ch;
    }
  }
  return out + '"';
}

const CODEX_HALLPASS_PROFILES = new Set([
  "profiles.fast",
  "profiles.balanced",
  "profiles.deep",
]);

export const VALID_REASONING_LEVELS = new Set([
  "auto",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
  "ultra",
]);

function supportsReasoningId(id = "") {
  const s = String(id).toLowerCase();
  return (
    /^claude-(?:opus|sonnet|fable)/.test(s) ||
    /^claude-(?:3-7|4|5)/.test(s) ||
    /^(?:gpt-[56]|openai-gpt-oss|o[134]|codex)/.test(s) ||
    /^(?:deepseek-(?:r1|v3\.2|v4)|qwen-?3|qwq|kimi-k[23]|gemini-(?:2\.5|3|4)|grok-[34]|glm-[45]|minimax-m[23])/.test(
      s,
    )
  );
}

function stripHallpassFromCodexToml(existingToml, { removeTopLevelProvider = false } = {}) {
  const lines = existingToml
    ? existingToml.replace(/\r\n/g, "\n").split("\n")
    : [];
  const hadAnyHallpass = lines.some(
    (l) =>
      /^\s*model_provider\s*=\s*"hallpass"\s*(?:#.*)?$/.test(l) ||
      /^\s*\[\s*model_providers\.hallpass(?:\.[^\]]+)?\s*\]\s*(?:#.*)?$/.test(l),
  );
  const kept = [];
  let skippingHallpass = false;
  for (const line of lines) {
    const header = line.match(TOML_HEADER_RE);
    if (header) {
      const name = header[2].trim();
      skippingHallpass =
        name === "model_providers.hallpass" ||
        name.startsWith("model_providers.hallpass.") ||
        (hadAnyHallpass && CODEX_HALLPASS_PROFILES.has(name));
    }
    if (!skippingHallpass) kept.push(line);
  }
  if (removeTopLevelProvider) {
    const firstHeaderIdx = kept.findIndex((l) => TOML_HEADER_RE.test(l));
    const limit = firstHeaderIdx === -1 ? kept.length : firstHeaderIdx;
    const hadHallpassProvider = kept
      .slice(0, limit)
      .some((l) => /^\s*model_provider\s*=\s*"hallpass"\s*(?:#.*)?$/.test(l));
    const filtered = [];
    for (let i = 0; i < kept.length; i++) {
      if (
        i < limit &&
        (/^\s*model_provider\s*=\s*"hallpass"\s*(?:#.*)?$/.test(kept[i]) ||
          (hadHallpassProvider && /^\s*model\s*=/.test(kept[i])) ||
          (hadHallpassProvider && /^\s*model_reasoning_effort\s*=/.test(kept[i])) ||
          (hadHallpassProvider && /^\s*web_search\s*=\s*"disabled"\s*(?:#.*)?$/.test(kept[i])))
      ) {
        continue;
      }
      filtered.push(kept[i]);
    }
    while (filtered.length && filtered[filtered.length - 1].trim() === "")
      filtered.pop();
    return filtered.length ? filtered.join("\n") + "\n" : "";
  }
  return kept;
}

export function upsertCodexToml(
  existingToml,
  {
    model,
    apiBase,
    nodePath,
    helperPath,
    reasoningEffort = null,
    providerOnly = false,
  },
) {
  const kept = stripHallpassFromCodexToml(existingToml);
  const codexEff =
    reasoningEffort &&
    ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(
      reasoningEffort,
    )
      ? reasoningEffort
      : null;

  if (!providerOnly) {
    // Update or insert top-level `model`, `model_provider`, and optional `model_reasoning_effort` BEFORE the first `[section]` / `[[array]]`.
    const firstSectionIdx = kept.findIndex((l) => TOML_HEADER_RE.test(l));
    let limit = firstSectionIdx === -1 ? kept.length : firstSectionIdx;
    let sawModel = false;
    let sawProvider = false;
    let sawWebSearch = false;
    let sawReasoning = false;
    for (let i = 0; i < limit; i++) {
      if (/^\s*model\s*=/.test(kept[i])) {
        kept[i] = `model = ${tomlBasicString(model)}`;
        sawModel = true;
      } else if (/^\s*model_provider\s*=/.test(kept[i])) {
        kept[i] = `model_provider = "hallpass"`;
        sawProvider = true;
      } else if (/^\s*web_search\s*=/.test(kept[i])) {
        kept[i] = `web_search = "disabled"`;
        sawWebSearch = true;
      } else if (/^\s*model_reasoning_effort\s*=/.test(kept[i])) {
        if (codexEff) {
          kept[i] = `model_reasoning_effort = ${tomlBasicString(codexEff)}`;
          sawReasoning = true;
        } else {
          kept.splice(i, 1);
          i--;
          limit--;
        }
      }
    }
    const topInserts = [];
    if (!sawModel) topInserts.push(`model = ${tomlBasicString(model)}`);
    if (!sawProvider) topInserts.push(`model_provider = "hallpass"`);
    if (codexEff && !sawReasoning) {
      topInserts.push(`model_reasoning_effort = ${tomlBasicString(codexEff)}`);
    }
    if (!sawWebSearch) topInserts.push(`web_search = "disabled"`);
    if (topInserts.length) {
      kept.splice(
        0,
        0,
        ...topInserts,
        ...(kept.length && kept[0] !== "" ? [""] : []),
      );
    }
  }

  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const block = [
    ...(kept.length ? [""] : []),
    "[model_providers.hallpass]",
    `name = "HallPass"`,
    `base_url = ${tomlBasicString(apiBase)}`,
    `wire_api = "responses"`,
    `supports_websockets = false`,
    "",
    "[model_providers.hallpass.auth]",
    `command = ${tomlBasicString(nodePath)}`,
    `args = [${tomlBasicString(helperPath)}, "codex"]`,
    `timeout_ms = 6000`,
    "",
  ];
  return [...kept, ...block].join("\n");
}

function buildCodexProfileToml({ model, reasoningEffort = null }) {
  const codexEff =
    reasoningEffort &&
    ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(
      reasoningEffort,
    )
      ? reasoningEffort
      : null;
  return (
    [
      `model_provider = "hallpass"`,
      `model = ${tomlBasicString(model)}`,
      ...(codexEff ? [`model_reasoning_effort = ${tomlBasicString(codexEff)}`] : []),
      `web_search = "disabled"`,
    ].join("\n") + "\n"
  );
}

const SHELL_START = "# >>> hallpass >>>";
const SHELL_END = "# <<< hallpass <<<";

function hasControlChars(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function shSingleQuote(value) {
  const str = String(value);
  if (hasControlChars(str)) {
    throw new Error(
      "Refusing to write control characters into shell configuration.",
    );
  }
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function fishSingleQuote(value) {
  const str = String(value);
  if (hasControlChars(str)) {
    throw new Error(
      "Refusing to write control characters into fish configuration.",
    );
  }
  return `'${str.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function upsertShellBlock(existingContent, envFilePath, isFish = false) {
  const stripped = (existingContent || "")
    .replace(new RegExp(`\\n?${SHELL_START}[\\s\\S]*?${SHELL_END}\\n?`, "g"), "\n")
    .trimEnd();
  const qPath = isFish
    ? fishSingleQuote(envFilePath)
    : shSingleQuote(envFilePath);
  const sourceLine = isFish
    ? `test -f ${qPath}; and source ${qPath} 2>/dev/null`
    : `[ -f ${qPath} ] && . ${qPath}`;
  const block = `${SHELL_START}\n${sourceLine}\n${SHELL_END}\n`;
  return stripped ? `${stripped}\n\n${block}` : block;
}

export function copyToClipboard(text) {
  const cmds =
    process.platform === "darwin"
      ? [["/usr/bin/pbcopy", []]]
      : process.platform === "win32"
        ? [
            [
              path.join(
                process.env.SystemRoot || "C:\\Windows",
                "System32",
                "clip.exe",
              ),
              [],
            ],
          ]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  for (const [cmd, args] of cmds) {
    const res = spawnSync(cmd, args, {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 3000,
    });
    if (res.status === 0) return true;
  }
  return false;
}

function buildClaudeModelPickerOptions(chosenClaude, models = [], existingOptions = []) {
  const seen = new Set();
  const options = [];
  const pushOption = (mObj) => {
    if (!mObj?.id || seen.has(mObj.id)) return;
    seen.add(mObj.id);
    const isClaude = mObj.provider === "Anthropic" || /^claude[-_]/i.test(mObj.id);
    options.push({
      model: mObj.id,
      label: `${mObj.name || mObj.id} (HallPass)`,
      description: isClaude
        ? "Anthropic model via HallPass"
        : `${mObj.provider || "Frontier"} model via HallPass`,
      ...(!isClaude ? { behavesAs: "claude-sonnet-4-6" } : {}),
    });
  };
  for (const prev of existingOptions) {
    if (prev && typeof prev.model === "string" && !seen.has(prev.model)) {
      seen.add(prev.model);
      options.push(prev);
    }
  }
  const msgModels = models.filter((m) => m.protocols?.includes("messages"));
  const chosenObj =
    msgModels.find((m) => m.id === chosenClaude) || { id: chosenClaude, name: chosenClaude };
  pushOption(chosenObj);
  for (const m of msgModels.slice(0, 6)) {
    if (options.length >= 6) break;
    pushOption(m);
  }
  return options;
}

function buildOpencodeModelEntry(m, { chosenModel, ocEffort, prevEntry = null } = {}) {
  const canReason = Boolean(m.reasoning || supportsReasoningId(m.id));
  const ctxLimit =
    Number.isInteger(m.contextLength) && m.contextLength > 0
      ? m.contextLength
      : Number.isInteger(prevEntry?.limit?.context) && prevEntry.limit.context > 0
        ? prevEntry.limit.context
        : 128000;
  const hasCost =
    typeof m.inputPerMillion === "number" &&
    typeof m.outputPerMillion === "number";
  const costBlock = hasCost
    ? {
        input: m.inputPerMillion,
        output: m.outputPerMillion,
        ...(typeof m.cacheReadPerMillion === "number"
          ? { cache_read: m.cacheReadPerMillion }
          : {}),
        ...(typeof m.cacheWritePerMillion === "number"
          ? { cache_write: m.cacheWritePerMillion }
          : {}),
      }
    : prevEntry?.cost && typeof prevEntry.cost === "object"
      ? prevEntry.cost
      : null;
  return {
    name: m.name || prevEntry?.name || m.id,
    tool_call: true,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    ...(canReason ? { reasoning: true } : {}),
    limit: { context: ctxLimit, output: 16384 },
    ...(costBlock ? { cost: costBlock } : {}),
    ...(canReason && ocEffort && m.id === chosenModel
      ? { options: { reasoningEffort: ocEffort } }
      : {}),
    ...(canReason
      ? {
          variants: {
            low: { reasoningEffort: "low" },
            medium: { reasoningEffort: "medium" },
            high: { reasoningEffort: "high" },
          },
        }
      : {}),
  };
}

function resolveShellRcTarget(homeDir, shell = "/bin/zsh") {
  const isFish = shell.includes("fish");
  if (isFish) {
    return {
      rcPath: path.join(homeDir, ".config", "fish", "config.fish"),
      isFish: true,
    };
  }
  if (shell.includes("bash")) {
    const bashrc = path.join(homeDir, ".bashrc");
    return { rcPath: bashrc, isFish: false };
  }
  return { rcPath: path.join(homeDir, ".zshrc"), isFish: false };
}

export function configureAgent(
  agent,
  payload,
  {
    homeDir = os.homedir(),
    dryRun = false,
    nodePath = process.execPath,
    shell = process.env.SHELL || "/bin/zsh",
    reasoningEffort = null,
    mode = "default",
  } = {},
) {
  const effectiveMode = mode === "coexist" ? "coexist" : "default";
  const { token, apiBase, model, models = [] } = payload;
  const effectiveToken = dryRun ? "hp_live_••••••••" : token;
  const anthropicBase = apiBase.replace(/\/v1\/?$/, "");
  const rawEffort =
    typeof reasoningEffort === "string" &&
    VALID_REASONING_LEVELS.has(reasoningEffort.toLowerCase())
      ? reasoningEffort.toLowerCase()
      : null;
  const normEffort =
    rawEffort && rawEffort !== "auto" && rawEffort !== "none" ? rawEffort : null;

  if (agent === "claude-code") {
    const claudeModels = models.filter(
      (m) =>
        m.protocols?.includes("messages") &&
        (m.provider === "Anthropic" || /^claude[-_]/i.test(m.id)),
    );
    const chosenClaude =
      models.find((m) => m.id === model && m.protocols?.includes("messages"))
        ?.id ||
      claudeModels.find((m) => m.id === model)?.id ||
      claudeModels[0]?.id ||
      models.find((m) => m.protocols?.includes("messages"))?.id ||
      model;
    const defaultOpus = claudeModels.find((m) => /opus/i.test(m.id))?.id;
    const defaultSonnet = claudeModels.find((m) => /sonnet/i.test(m.id))?.id;
    const defaultHaiku = claudeModels.find((m) => /haiku/i.test(m.id))?.id;
    const mappedClaudeEffort =
      normEffort === "xhigh" || normEffort === "ultra"
        ? "max"
        : normEffort === "minimal"
          ? "low"
          : normEffort;
    const claudeEffort =
      mappedClaudeEffort &&
      ["low", "medium", "high", "max"].includes(mappedClaudeEffort) &&
      supportsReasoningId(chosenClaude)
        ? mappedClaudeEffort
        : null;

    const chosenClaudeObj =
      models.find((m) => m.id === chosenClaude) ||
      claudeModels.find((m) => m.id === chosenClaude) ||
      null;
    const claudeMaxOut = String(
      Number.isInteger(chosenClaudeObj?.maxOutputTokens) &&
        chosenClaudeObj.maxOutputTokens > 0
        ? Math.min(chosenClaudeObj.maxOutputTokens, 32768)
        : 8192,
    );

    const buildClaudeSettingsJson = (baseObj = {}) => {
      const nextEnv = {
        ...(baseObj.env && typeof baseObj.env === "object" ? baseObj.env : {}),
        ANTHROPIC_BASE_URL: anthropicBase,
        ANTHROPIC_AUTH_TOKEN: effectiveToken,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: chosenClaude,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: claudeMaxOut,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ...(defaultOpus ? { ANTHROPIC_DEFAULT_OPUS_MODEL: defaultOpus } : {}),
        ...(defaultSonnet ? { ANTHROPIC_DEFAULT_SONNET_MODEL: defaultSonnet } : {}),
        ...(defaultHaiku ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: defaultHaiku } : {}),
      };
      delete nextEnv.CLAUDE_CODE_EFFORT_LEVEL;
      const pickerOpts =
        models.length > 2
          ? buildClaudeModelPickerOptions(
              chosenClaude,
              models,
              baseObj.modelPicker?.options || [],
            )
          : null;
      const next = {
        ...baseObj,
        ...(claudeEffort ? { effortLevel: claudeEffort } : {}),
        ...(pickerOpts
          ? {
              modelPicker: {
                replaceBuiltInOptions: false,
                options: pickerOpts,
              },
            }
          : {}),
        env: nextEnv,
      };
      if (!claudeEffort && Object.hasOwn(next, "effortLevel")) {
        delete next.effortLevel;
      }
      return JSON.stringify(next, null, 2) + "\n";
    };

    if (effectiveMode === "coexist") {
      const sideSettingsPath = path.join(
        hallpassDir(homeDir),
        "claude-settings.json",
      );
      const existingSide = readJsonSafe(sideSettingsPath);
      const content = buildClaudeSettingsJson(existingSide);
      if (!dryRun) {
        storeCredential(
          "claude-code",
          { token, apiBase, model: chosenClaude, reasoning: claudeEffort, mode: "coexist" },
          { homeDir },
        );
        writePrivateFile(sideSettingsPath, content, 0o600);
        const realClaude = resolveRealBinary("claude", process.env, homeDir);
        const shimPath = writeShimScript(homeDir, "claude-hp", [
          `exec ${shSingleQuote(realClaude)} --settings ${shSingleQuote(sideSettingsPath)} "$@"`,
        ]);
        return {
          agent,
          mode: "coexist",
          appliedModel: chosenClaude,
          appliedReasoning: claudeEffort,
          files: [sideSettingsPath, shimPath],
          backup: null,
          launchCommand: `${shSingleQuote(shimPath)}`,
          nextStep: `Run \`${shimPath}\` or \`npx hallpassai run claude\` (plain \`claude\` keeps your existing subscription login).`,
        };
      }
      return {
        agent,
        mode: "coexist",
        appliedModel: chosenClaude,
        appliedReasoning: claudeEffort,
        files: [sideSettingsPath],
        preview: content,
      };
    }

    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const current = readJsonSafe(settingsPath);
    const wasManagedByHallpass = Boolean(
      current?.env?.ANTHROPIC_BASE_URL && current?.env?.ANTHROPIC_AUTH_TOKEN,
    );
    const hasNonHallpassClaudeKeys = (() => {
      const probe = structuredClone(current);
      if (wasManagedByHallpass) {
        delete probe.effortLevel;
        delete probe.modelPicker;
      }
      if (probe.env && typeof probe.env === "object") {
        delete probe.env.ANTHROPIC_BASE_URL;
        delete probe.env.ANTHROPIC_AUTH_TOKEN;
        delete probe.env.ANTHROPIC_MODEL;
        delete probe.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
        delete probe.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        delete probe.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        delete probe.env.CLAUDE_CODE_EFFORT_LEVEL;
        if (probe.env.ANTHROPIC_API_KEY === "") delete probe.env.ANTHROPIC_API_KEY;
        delete probe.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
        delete probe.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
        if (!Object.keys(probe.env).length) delete probe.env;
      }
      return Object.keys(probe).length > 0;
    })();
    const content = buildClaudeSettingsJson(current);
    if (!dryRun) {
      if (!wasManagedByHallpass) {
        savePreviousAgentState(
          "claude-code",
          {
            existed: fs.existsSync(settingsPath),
            hadEffortLevel: Object.hasOwn(current, "effortLevel"),
            effortLevel: current.effortLevel ?? null,
            hadModelPicker: Object.hasOwn(current, "modelPicker"),
            modelPicker: current.modelPicker ?? null,
            envKeys: {
              ANTHROPIC_BASE_URL: current?.env?.ANTHROPIC_BASE_URL ?? null,
              ANTHROPIC_AUTH_TOKEN: current?.env?.ANTHROPIC_AUTH_TOKEN ?? null,
              ANTHROPIC_API_KEY: current?.env?.ANTHROPIC_API_KEY ?? null,
              ANTHROPIC_MODEL: current?.env?.ANTHROPIC_MODEL ?? null,
              ANTHROPIC_DEFAULT_OPUS_MODEL:
                current?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null,
              ANTHROPIC_DEFAULT_SONNET_MODEL:
                current?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null,
              ANTHROPIC_DEFAULT_HAIKU_MODEL:
                current?.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null,
              CLAUDE_CODE_EFFORT_LEVEL:
                current?.env?.CLAUDE_CODE_EFFORT_LEVEL ?? null,
              CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:
                current?.env?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? null,
              CLAUDE_CODE_MAX_OUTPUT_TOKENS:
                current?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
            },
          },
          homeDir,
        );
      }
      storeCredential(
        "claude-code",
        { token, apiBase, model: chosenClaude, reasoning: claudeEffort, mode: "default" },
        { homeDir },
      );
      const backup = hasNonHallpassClaudeKeys
        ? backupOnce(settingsPath, { secret: true })
        : null;
      writePrivateFile(settingsPath, content, 0o600);
      return {
        agent,
        mode: "default",
        appliedModel: chosenClaude,
        appliedReasoning: claudeEffort,
        files: [settingsPath],
        backup,
        launchCommand: "claude",
        nextStep:
          "Run `claude` in this terminal (switch models & effort anytime with `/model` and `/effort`).",
      };
    }
    return {
      agent,
      mode: "default",
      appliedModel: chosenClaude,
      appliedReasoning: claudeEffort,
      files: [settingsPath],
      preview: content,
    };
  }

  if (agent === "codex") {
    const codexDir = resolveCodexDir(homeDir);
    const configPath = path.join(codexDir, "config.toml");
    assertNotSymlink(configPath);
    const existing = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8")
      : "";
    const helperPath = helperScriptPath(homeDir);
    const openAiResponses = models.filter(
      (m) =>
        m.protocols?.includes("responses") &&
        (m.provider === "OpenAI" || /^(?:gpt-|openai-gpt-|o[134]|codex)/i.test(m.id)),
    );
    const compatible =
      models.find((m) => m.id === model && m.protocols?.includes("responses"))
        ?.id ||
      openAiResponses[0]?.id ||
      models.find((m) => m.protocols?.includes("responses"))?.id ||
      model;
    const isGpt6 = /^gpt-6/i.test(compatible);
    const rawCodexEff =
      rawEffort === "none"
        ? "none"
        : normEffort && ["minimal", "low", "medium", "high", "xhigh"].includes(normEffort)
          ? normEffort
          : normEffort === "max" || normEffort === "ultra"
            ? isGpt6
              ? normEffort
              : "xhigh"
            : null;
    const codexEffort =
      rawCodexEff && supportsReasoningId(compatible) ? rawCodexEff : null;

    if (effectiveMode === "coexist") {
      const profilePath = path.join(codexDir, "hallpass.config.toml");
      const content = upsertCodexToml(existing, {
        model: compatible,
        apiBase,
        nodePath,
        helperPath,
        reasoningEffort: codexEffort,
        providerOnly: true,
      });
      const profileContent = buildCodexProfileToml({
        model: compatible,
        reasoningEffort: codexEffort,
      });
      if (!dryRun) {
        storeCredential(
          "codex",
          { token, apiBase, model: compatible, reasoning: codexEffort, mode: "coexist" },
          { homeDir },
        );
        writePrivateFile(configPath, content, 0o600);
        writePrivateFile(profilePath, profileContent, 0o600);
        const realCodex = resolveRealBinary("codex", process.env, homeDir);
        const shimPath = writeShimScript(homeDir, "codex-hp", [
          `exec ${shSingleQuote(realCodex)} -p hallpass "$@"`,
        ]);
        return {
          agent,
          mode: "coexist",
          appliedModel: compatible,
          appliedReasoning: codexEffort,
          files: [configPath, profilePath, helperPath, shimPath],
          backup: null,
          launchCommand: "codex -p hallpass",
          nextStep:
            "Run `codex -p hallpass` (plain `codex` keeps your existing OpenAI/ChatGPT login).",
        };
      }
      return {
        agent,
        mode: "coexist",
        appliedModel: compatible,
        appliedReasoning: codexEffort,
        files: [configPath, profilePath],
        preview: `# ~/.codex/hallpass.config.toml\n${profileContent}\n# ~/.codex/config.toml\n${content}`,
      };
    }

    const content = upsertCodexToml(existing, {
      model: compatible,
      apiBase,
      nodePath,
      helperPath,
      reasoningEffort: codexEffort,
      providerOnly: false,
    });
    if (!dryRun) {
      const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
      const firstHeader = lines.findIndex((l) => TOML_HEADER_RE.test(l));
      const rootLines = lines.slice(0, firstHeader === -1 ? lines.length : firstHeader);
      const hadHallpass = rootLines.some((l) =>
        /^\s*model_provider\s*=\s*"hallpass"/.test(l),
      );
      if (!hadHallpass) {
        const findRoot = (re) => rootLines.find((l) => re.test(l)) ?? null;
        savePreviousAgentState(
          "codex",
          {
            existed: fs.existsSync(configPath),
            modelLine: findRoot(/^\s*model\s*=/),
            providerLine: findRoot(/^\s*model_provider\s*=/),
            reasoningLine: findRoot(/^\s*model_reasoning_effort\s*=/),
            webSearchLine: findRoot(/^\s*web_search\s*=/),
          },
          homeDir,
        );
      }
      storeCredential(
        "codex",
        { token, apiBase, model: compatible, reasoning: codexEffort, mode: "default" },
        { homeDir },
      );
      const nonHallpassToml = existing
        ? stripHallpassFromCodexToml(existing, { removeTopLevelProvider: true }).trim()
        : "";
      const backup = nonHallpassToml
        ? backupOnce(configPath, { secret: true })
        : null;
      writePrivateFile(configPath, content, 0o600);
      return {
        agent,
        mode: "default",
        appliedModel: compatible,
        appliedReasoning: codexEffort,
        files: [configPath, helperPath],
        backup,
        launchCommand: "codex",
        nextStep:
          'Run `codex` (switch models with `/model` or override reasoning with `codex -c model_reasoning_effort="high"`).',
      };
    }
    return {
      agent,
      mode: "default",
      appliedModel: compatible,
      appliedReasoning: codexEffort,
      files: [configPath],
      preview: content,
    };
  }

  if (agent === "opencode") {
    const { configDir, dataDir } = resolveOpencodeDirs(homeDir);
    const configPath = path.join(configDir, "opencode.json");
    const authPath = path.join(dataDir, "auth.json");
    const currentCfg = readJsonSafe(configPath);
    const existingModels =
      currentCfg.provider?.hallpass?.models &&
      typeof currentCfg.provider.hallpass.models === "object"
        ? currentCfg.provider.hallpass.models
        : {};

    const chatModels = models.filter((m) =>
      m.protocols?.includes("chat/completions"),
    );
    const chosenModel =
      chatModels.find((m) => m.id === model)?.id ||
      chatModels[0]?.id ||
      model;
    const mappedOcEff =
      normEffort && ["low", "medium", "high"].includes(normEffort)
        ? normEffort
        : normEffort === "max" || normEffort === "xhigh" || normEffort === "ultra"
          ? "high"
          : normEffort === "minimal"
            ? "low"
            : null;
    const chosenSupportsReasoning = Boolean(
      chatModels.find((m) => m.id === chosenModel)?.reasoning ||
        supportsReasoningId(chosenModel),
    );
    const ocEffort = chosenSupportsReasoning ? mappedOcEff : null;
    const modelEntries = Object.create(null);
    if (chatModels.length <= 1) {
      for (const [k, v] of Object.entries(existingModels)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype")
          continue;
        if (v && typeof v === "object") {
          const clone = { ...v };
          delete clone.options;
          modelEntries[k] = clone;
        }
      }
    }
    for (const m of chatModels.length
      ? chatModels
      : [{ id: chosenModel, name: chosenModel }]) {
      if (
        m.id === "__proto__" ||
        m.id === "constructor" ||
        m.id === "prototype"
      )
        continue;
      modelEntries[m.id] = buildOpencodeModelEntry(m, {
        chosenModel,
        ocEffort,
        prevEntry: modelEntries[m.id],
      });
    }

    const preserveExistingRootModel =
      effectiveMode === "coexist" &&
      typeof currentCfg.model === "string" &&
      !currentCfg.model.startsWith("hallpass/");

    const nextCfg = {
      $schema: currentCfg.$schema || "https://opencode.ai/config.json",
      ...currentCfg,
      ...(effectiveMode === "default"
        ? { model: `hallpass/${chosenModel}` }
        : preserveExistingRootModel
          ? { model: currentCfg.model }
          : {}),
      provider: {
        ...(currentCfg.provider && typeof currentCfg.provider === "object"
          ? currentCfg.provider
          : {}),
        hallpass: {
          npm: "@ai-sdk/openai-compatible",
          name: "HallPass",
          options: {
            baseURL: apiBase,
          },
          models: modelEntries,
        },
      },
    };
    if (effectiveMode === "coexist" && !preserveExistingRootModel) {
      delete nextCfg.model;
    }
    const cfgContent = JSON.stringify(nextCfg, null, 2) + "\n";

    const currentAuth = readJsonSafe(authPath);
    const nextAuth = {
      ...currentAuth,
      hallpass: {
        type: "api",
        key: effectiveToken,
      },
    };
    const authContent = JSON.stringify(nextAuth, null, 2) + "\n";

    if (!dryRun) {
      if (
        effectiveMode === "default" &&
        (typeof currentCfg.model !== "string" ||
          !currentCfg.model.startsWith("hallpass/"))
      ) {
        savePreviousAgentState(
          "opencode",
          {
            existed: fs.existsSync(configPath),
            previousModel: currentCfg.model ?? null,
          },
          homeDir,
        );
      }
      storeCredential(
        "opencode",
        { token, apiBase, model: chosenModel, reasoning: ocEffort, mode: effectiveMode },
        { homeDir },
      );
      const hasOtherProvider = Boolean(
        Object.keys(currentCfg).some((k) => !["$schema", "model", "provider"].includes(k)) ||
          Object.keys(currentCfg.provider || {}).some((p) => p !== "hallpass") ||
          (typeof currentCfg.model === "string" && !currentCfg.model.startsWith("hallpass/")),
      );
      const hasOtherAuth = Object.keys(currentAuth).some((k) => k !== "hallpass");
      const backup = hasOtherProvider ? backupOnce(configPath, { secret: true }) : null;
      if (hasOtherAuth) backupOnce(authPath, { secret: true });
      writePrivateFile(configPath, cfgContent, 0o600);
      writePrivateFile(authPath, authContent, 0o600);
      return {
        agent,
        mode: effectiveMode,
        appliedModel: chosenModel,
        appliedReasoning: ocEffort,
        files: [configPath, authPath],
        backup,
        launchCommand:
          effectiveMode === "coexist"
            ? `opencode -m hallpass/${chosenModel}`
            : "opencode",
        nextStep:
          effectiveMode === "coexist"
            ? `Run \`opencode -m hallpass/${chosenModel}\` or pick any HallPass model in \`/models\`.`
            : "Run `opencode` in this terminal (switch models with `/models` or variant with `Ctrl+T`).",
      };
    }
    return {
      agent,
      mode: effectiveMode,
      appliedModel: chosenModel,
      appliedReasoning: ocEffort,
      files: [configPath, authPath],
      preview: cfgContent,
    };
  }

  if (agent === "copilot") {
    const dir = hallpassDir(homeDir);
    const envPath = path.join(dir, "copilot.env");
    const chosenObj =
      models.find(
        (m) =>
          m.id === model &&
          (m.protocols?.includes("responses") ||
            m.protocols?.includes("chat/completions")),
      ) ||
      models.find((m) => m.protocols?.includes("chat/completions")) ||
      models.find((m) => m.protocols?.includes("responses")) ||
      null;
    const chosenModel = chosenObj?.id || model;
    const useResponsesWire = Boolean(
      chosenObj?.protocols?.includes("responses") &&
        (chosenObj?.provider === "OpenAI" ||
          /^(?:gpt-[56]|o[134]|codex)/i.test(chosenModel)),
    );
    const copilotMaxOut = String(
      Number.isInteger(chosenObj?.maxOutputTokens) &&
        chosenObj.maxOutputTokens > 0
        ? Math.min(chosenObj.maxOutputTokens, 32768)
        : 8192,
    );
    const { rcPath, isFish } = resolveShellRcTarget(homeDir, shell);
    const envContent = [
      `# HallPass configuration for GitHub Copilot CLI`,
      `export COPILOT_OFFLINE='true'`,
      `export COPILOT_PROVIDER_TYPE='openai'`,
      `export COPILOT_PROVIDER_WIRE_API=${shSingleQuote(useResponsesWire ? "responses" : "completions")}`,
      `export COPILOT_PROVIDER_BASE_URL=${shSingleQuote(apiBase)}`,
      `export COPILOT_PROVIDER_API_KEY=${shSingleQuote(effectiveToken)}`,
      `export COPILOT_MODEL=${shSingleQuote(chosenModel)}`,
      `export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS=${shSingleQuote(copilotMaxOut)}`,
      `export COPILOT_PROVIDER_VISION='true'`,
      `export COPILOT_PROVIDER_HEADERS='X-Client-Name: copilot'`,
      "",
    ].join("\n");
    const fishEnvPath = path.join(dir, "copilot.fish");
    const fishEnvContent = [
      `# HallPass configuration for GitHub Copilot CLI (fish)`,
      `set -gx COPILOT_OFFLINE 'true'`,
      `set -gx COPILOT_PROVIDER_TYPE 'openai'`,
      `set -gx COPILOT_PROVIDER_WIRE_API ${fishSingleQuote(useResponsesWire ? "responses" : "completions")}`,
      `set -gx COPILOT_PROVIDER_BASE_URL ${fishSingleQuote(apiBase)}`,
      `set -gx COPILOT_PROVIDER_API_KEY ${fishSingleQuote(effectiveToken)}`,
      `set -gx COPILOT_MODEL ${fishSingleQuote(chosenModel)}`,
      `set -gx COPILOT_PROVIDER_MAX_OUTPUT_TOKENS ${fishSingleQuote(copilotMaxOut)}`,
      `set -gx COPILOT_PROVIDER_VISION 'true'`,
      `set -gx COPILOT_PROVIDER_HEADERS 'X-Client-Name: copilot'`,
      "",
    ].join("\n");

    if (effectiveMode === "coexist") {
      if (!dryRun) {
        storeCredential(
          "copilot",
          { token, apiBase, model: chosenModel, mode: "coexist" },
          { homeDir },
        );
        writePrivateFile(envPath, envContent, 0o600);
        const realCopilot = resolveRealBinary("copilot", process.env, homeDir);
        const shimPath = writeShimScript(homeDir, "copilot-hp", [
          `. ${shSingleQuote(envPath)}`,
          `exec ${shSingleQuote(realCopilot)} "$@"`,
        ]);
        return {
          agent,
          mode: "coexist",
          appliedModel: chosenModel,
          appliedReasoning: null,
          files: [envPath, shimPath],
          backup: null,
          launchCommand: `${shSingleQuote(shimPath)}`,
          nextStep: `Run \`${shimPath}\` or \`npx hallpassai run copilot\` (plain \`copilot\` keeps your GitHub Copilot login).`,
        };
      }
      return {
        agent,
        mode: "coexist",
        appliedModel: chosenModel,
        appliedReasoning: null,
        files: [envPath],
        preview: envContent,
      };
    }

    assertNotSymlink(rcPath);
    const existingRc = fs.existsSync(rcPath)
      ? fs.readFileSync(rcPath, "utf8")
      : "";
    const activeEnvPath = isFish ? fishEnvPath : envPath;
    const nextRc = upsertShellBlock(existingRc, activeEnvPath, isFish);

    if (!dryRun) {
      storeCredential(
        "copilot",
        { token, apiBase, model: chosenModel, mode: "default" },
        { homeDir },
      );
      writePrivateFile(envPath, envContent, 0o600);
      if (isFish) writePrivateFile(fishEnvPath, fishEnvContent, 0o600);
      const nonHallpassRc = existingRc
        .replace(new RegExp(`\\n?${SHELL_START}[\\s\\S]*?${SHELL_END}\\n?`, "g"), "")
        .trim();
      const backup = nonHallpassRc ? backupOnce(rcPath) : null;
      const rcMode = fs.existsSync(rcPath)
        ? fs.statSync(rcPath).mode & 0o777 || 0o644
        : 0o644;
      writePrivateFile(rcPath, nextRc, rcMode);
      const extraFiles = isFish ? [fishEnvPath] : [];
      if (process.platform === "darwin" && shell.includes("bash")) {
        const bp = path.join(homeDir, ".bash_profile");
        if (fs.existsSync(bp)) {
          assertNotSymlink(bp);
          const rawBp = fs.readFileSync(bp, "utf8");
          writePrivateFile(bp, upsertShellBlock(rawBp, envPath, false), 0o644);
          extraFiles.push(bp);
        }
      }
      return {
        agent,
        mode: "default",
        appliedModel: chosenModel,
        appliedReasoning: null,
        files: [envPath, rcPath, ...extraFiles],
        backup,
        launchCommand: isFish
          ? `source ${fishSingleQuote(fishEnvPath)}; and copilot`
          : `source ${shSingleQuote(envPath)} && copilot`,
        nextStep: isFish
          ? `Run \`source ${fishSingleQuote(fishEnvPath)}; and copilot\` in this terminal (new terminals load it automatically).`
          : `Run \`source ${shSingleQuote(envPath)} && copilot\` in this terminal (new terminals load it automatically).`,
      };
    }
    return {
      agent,
      mode: "default",
      appliedModel: chosenModel,
      appliedReasoning: null,
      files: [envPath, rcPath],
      preview: envContent,
    };
  }

  if (agent === "cursor") {
    const chosenModel =
      models.find(
        (m) => m.id === model && m.protocols?.includes("chat/completions"),
      )?.id ||
      models.find((m) => m.protocols?.includes("chat/completions"))?.id ||
      model;
    if (!dryRun) {
      storeCredential(
        "cursor",
        { token, apiBase, model: chosenModel, mode: "default" },
        { homeDir },
      );
    }
    return {
      agent,
      mode: "default",
      appliedModel: chosenModel,
      appliedReasoning: null,
      files: [],
      cursorValues: {
        apiKey: effectiveToken,
        baseUrl: apiBase,
        model: chosenModel,
      },
      nextStep:
        "In Cursor → Settings → Models: paste OpenAI API Key, enable Override OpenAI Base URL, and add the model.",
    };
  }

  throw new Error(`Unsupported agent: ${agent}`);
}

export function addModelToAgent(
  agent,
  modelId,
  { homeDir = os.homedir(), catalogModels = [] } = {},
) {
  const creds = readStoredCredentials(homeDir);
  const entry = creds.keys?.[agent];
  if (!entry?.token || !entry?.apiBase) {
    throw new Error(
      `${agent} is not configured yet. Pair it first at https://app.hallpassai.com/start.html#connect`,
    );
  }
  const mObj = catalogModels.find((m) => m.id === modelId) || {
    id: modelId,
    name: modelId,
    provider: "HallPass",
    protocols: ["messages", "responses", "chat/completions"],
    reasoning: supportsReasoningId(modelId),
  };

  if (agent === "claude-code") {
    if (entry.paused) {
      throw new Error(
        "claude-code is currently paused. Run `npx hallpassai resume claude-code` first.",
      );
    }
    const targetPath =
      entry.mode === "coexist"
        ? path.join(hallpassDir(homeDir), "claude-settings.json")
        : path.join(homeDir, ".claude", "settings.json");
    const cur = readJsonSafe(targetPath);
    const existingOpts = Array.isArray(cur.modelPicker?.options)
      ? cur.modelPicker.options.filter((o) => o?.model !== modelId)
      : [];
    const isClaude = mObj.provider === "Anthropic" || /^claude[-_]/i.test(modelId);
    const nextOpts = [
      ...existingOpts,
      {
        model: modelId,
        label: `${mObj.name || modelId} (HallPass)`,
        description: isClaude
          ? "Anthropic model via HallPass"
          : `${mObj.provider || "Frontier"} model via HallPass`,
        ...(!isClaude ? { behavesAs: "claude-sonnet-4-6" } : {}),
      },
    ];
    cur.modelPicker = {
      replaceBuiltInOptions: Boolean(cur.modelPicker?.replaceBuiltInOptions),
      options: nextOpts,
    };
    writePrivateFile(targetPath, JSON.stringify(cur, null, 2) + "\n", 0o600);
    return { agent, model: modelId, files: [targetPath], hint: "Pick it anytime via `/model` in Claude Code." };
  }

  if (agent === "opencode") {
    const { configDir } = resolveOpencodeDirs(homeDir);
    const cfgPath = path.join(configDir, "opencode.json");
    const cur = readJsonSafe(cfgPath);
    cur.provider ||= {};
    cur.provider.hallpass ||= {
      npm: "@ai-sdk/openai-compatible",
      name: "HallPass",
      options: { baseURL: entry.apiBase },
      models: {},
    };
    cur.provider.hallpass.models ||= {};
    cur.provider.hallpass.models[modelId] = buildOpencodeModelEntry(mObj, {
      chosenModel: entry.model,
      ocEffort: entry.reasoning || null,
      prevEntry: cur.provider.hallpass.models[modelId],
    });
    writePrivateFile(cfgPath, JSON.stringify(cur, null, 2) + "\n", 0o600);
    return { agent, model: modelId, files: [cfgPath], hint: `Run \`opencode -m hallpass/${modelId}\` or select in \`/models\`.` };
  }

  if (agent === "codex" || agent === "copilot" || agent === "cursor") {
    const switched = switchAgentModel(agent, modelId, {
      homeDir,
      catalogModels: catalogModels.length ? catalogModels : [mObj],
    });
    return {
      agent,
      model: switched.appliedModel || modelId,
      files: switched.files || [],
      hint:
        agent === "codex"
          ? "Set as active Codex model (switch anytime via `/model`)."
          : agent === "copilot"
            ? "Updated Copilot model (re-source `~/.config/hallpass/copilot.env` in open shells)."
            : `Add "${modelId}" under Cursor → Settings → Models.`,
    };
  }
  throw new Error(`Unsupported agent: ${agent}`);
}

export function buildEphemeralLaunchSpec(
  agent,
  {
    token,
    apiBase,
    model,
    reasoning = null,
    catalogModels = [],
    extraArgs = [],
    env = process.env,
    homeDir = os.homedir(),
  },
) {
  const anthropicBase = apiBase.replace(/\/v1\/?$/, "");
  const cleanEnv = { ...env };
  if (agent === "claude-code") {
    const claudeBin = resolveRealBinary("claude", cleanEnv, homeDir);
    const claudeModels = catalogModels.filter(
      (m) =>
        m.protocols?.includes("messages") &&
        (m.provider === "Anthropic" || /^claude[-_]/i.test(m.id)),
    );
    const defaultOpus = claudeModels.find((m) => /opus/i.test(m.id))?.id;
    const defaultSonnet = claudeModels.find((m) => /sonnet/i.test(m.id))?.id;
    const defaultHaiku = claudeModels.find((m) => /haiku/i.test(m.id))?.id;
    const mappedEffort =
      reasoning === "xhigh" || reasoning === "ultra"
        ? "max"
        : reasoning === "minimal"
          ? "low"
          : ["low", "medium", "high", "max"].includes(reasoning)
            ? reasoning
            : null;
    const claudeEffort =
      mappedEffort && supportsReasoningId(model) ? mappedEffort : null;
    const inlineSettings = {
      ...(claudeEffort ? { effortLevel: claudeEffort } : {}),
      modelPicker: {
        replaceBuiltInOptions: false,
        options: buildClaudeModelPickerOptions(model, catalogModels),
      },
    };
    return {
      command: claudeBin,
      args: ["--settings", JSON.stringify(inlineSettings), ...extraArgs],
      env: {
        ...cleanEnv,
        ANTHROPIC_BASE_URL: anthropicBase,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: model,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16384",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ...(defaultOpus ? { ANTHROPIC_DEFAULT_OPUS_MODEL: defaultOpus } : {}),
        ...(defaultSonnet ? { ANTHROPIC_DEFAULT_SONNET_MODEL: defaultSonnet } : {}),
        ...(defaultHaiku ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: defaultHaiku } : {}),
      },
    };
  }

  if (agent === "codex") {
    const codexBin = resolveRealBinary("codex", cleanEnv, homeDir);
    const providerInline = `model_providers.hallpass={name="HallPass",base_url=${tomlBasicString(apiBase)},wire_api="responses",supports_websockets=false,env_key="HALLPASS_API_KEY"}`;
    const isGpt6 = /^gpt-6/i.test(model);
    const rawEff =
      reasoning === "none"
        ? "none"
        : reasoning && ["minimal", "low", "medium", "high", "xhigh"].includes(reasoning)
          ? reasoning
          : reasoning === "max" || reasoning === "ultra"
            ? isGpt6
              ? reasoning
              : "xhigh"
            : null;
    const eff = rawEff && supportsReasoningId(model) ? rawEff : null;
    return {
      command: codexBin,
      args: [
        "-c",
        providerInline,
        "-c",
        'model_provider="hallpass"',
        "-c",
        `model=${tomlBasicString(model)}`,
        "-c",
        'web_search="disabled"',
        ...(eff ? ["-c", `model_reasoning_effort=${tomlBasicString(eff)}`] : []),
        ...extraArgs,
      ],
      env: {
        ...cleanEnv,
        HALLPASS_API_KEY: token,
      },
    };
  }

  if (agent === "opencode") {
    const ocBin = resolveRealBinary("opencode", cleanEnv, homeDir);
    const mObj = catalogModels.find((m) => m.id === model) || {
      id: model,
      name: model,
      protocols: ["chat/completions"],
      reasoning: supportsReasoningId(model),
    };
    const mappedOcEff =
      reasoning && ["low", "medium", "high"].includes(reasoning)
        ? reasoning
        : reasoning === "max" || reasoning === "xhigh" || reasoning === "ultra"
          ? "high"
          : reasoning === "minimal"
            ? "low"
            : null;
    const eff =
      mappedOcEff && (mObj.reasoning || supportsReasoningId(model))
        ? mappedOcEff
        : null;
    const entries = {};
    for (const m of catalogModels.length ? catalogModels.filter((x) => x.protocols?.includes("chat/completions")) : [mObj]) {
      entries[m.id] = buildOpencodeModelEntry(m, { chosenModel: model, ocEffort: eff });
    }
    if (!entries[model]) {
      entries[model] = buildOpencodeModelEntry(mObj, { chosenModel: model, ocEffort: eff });
    }
    const inlineCfg = {
      $schema: "https://opencode.ai/config.json",
      model: `hallpass/${model}`,
      provider: {
        hallpass: {
          npm: "@ai-sdk/openai-compatible",
          name: "HallPass",
          options: {
            baseURL: apiBase,
            apiKey: "{env:HALLPASS_API_KEY}",
          },
          models: entries,
        },
      },
    };
    return {
      command: ocBin,
      args: [...extraArgs],
      env: {
        ...cleanEnv,
        HALLPASS_API_KEY: token,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineCfg),
      },
    };
  }

  if (agent === "copilot") {
    const cpBin = resolveRealBinary("copilot", cleanEnv, homeDir);
    const mObj = catalogModels.find((m) => m.id === model);
    const useResponsesWire = Boolean(
      mObj?.protocols?.includes("responses") &&
        (mObj?.provider === "OpenAI" || /^(?:gpt-[56]|o[134]|codex)/i.test(model)),
    );
    return {
      command: cpBin,
      args: [...extraArgs],
      env: {
        ...cleanEnv,
        COPILOT_OFFLINE: "true",
        COPILOT_PROVIDER_TYPE: "openai",
        COPILOT_PROVIDER_WIRE_API: useResponsesWire ? "responses" : "completions",
        COPILOT_PROVIDER_BASE_URL: apiBase,
        COPILOT_PROVIDER_API_KEY: token,
        COPILOT_MODEL: model,
        COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "16384",
        COPILOT_PROVIDER_VISION: "true",
        COPILOT_PROVIDER_HEADERS: "X-Client-Name: copilot",
      },
    };
  }

  throw new Error(`Ephemeral launch is not supported for ${agent}.`);
}

function mergeCodexRestoredRootLines(restoredRootLines, cleanedToml) {
  if (!restoredRootLines.length) return cleanedToml;
  const restoredKeys = new Set(
    restoredRootLines
      .map((l) => l.match(/^\s*([A-Za-z0-9_]+)\s*=/)?.[1])
      .filter(Boolean),
  );
  const lines = cleanedToml ? cleanedToml.replace(/\r\n/g, "\n").split("\n") : [];
  const firstHeaderIdx = lines.findIndex((l) => TOML_HEADER_RE.test(l));
  const limit = firstHeaderIdx === -1 ? lines.length : firstHeaderIdx;
  const deduped = lines.filter((line, idx) => {
    if (idx >= limit) return true;
    const key = line.match(/^\s*([A-Za-z0-9_]+)\s*=/)?.[1];
    return !key || !restoredKeys.has(key);
  });
  while (deduped.length && deduped[0].trim() === "") deduped.shift();
  const body = deduped.join("\n").trimEnd();
  return body
    ? `${restoredRootLines.join("\n")}\n\n${body}\n`
    : `${restoredRootLines.join("\n")}\n`;
}

function surgicallyRestoreGlobalConfig(
  a,
  {
    homeDir = os.homedir(),
    shell = process.env.SHELL || "/bin/zsh",
    keepAdditive = false,
    savedEntry = null,
  } = {},
) {
  const touched = [];
  const prev = readPreviousState(homeDir)[a] || null;
  const unlinkBak = (fp) => {
    const bak = `${fp}.hallpass.bak`;
    if (fs.existsSync(bak)) {
      assertNotSymlink(bak);
      fs.unlinkSync(bak);
    }
  };
  const removeIfEmptyDir = (dirPath) => {
    try {
      if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
        fs.rmdirSync(dirPath);
      }
    } catch {}
  };

  if (a === "claude-code") {
    const fp = path.join(homeDir, ".claude", "settings.json");
    if (fs.existsSync(fp) && savedEntry?.mode !== "coexist") {
      const cur = readJsonSafe(fp);
      const isHallpassManaged =
        Boolean(prev) ||
        savedEntry?.mode === "default" ||
        (typeof cur?.env?.ANTHROPIC_AUTH_TOKEN === "string" &&
          cur.env.ANTHROPIC_AUTH_TOKEN.startsWith("hp_live_")) ||
        (typeof cur?.env?.ANTHROPIC_BASE_URL === "string" &&
          /hallpassai\.com/i.test(cur.env.ANTHROPIC_BASE_URL));
      if (isHallpassManaged) {
        if (prev) {
          if (prev.hadEffortLevel) cur.effortLevel = prev.effortLevel;
          else delete cur.effortLevel;
          if (prev.hadModelPicker) cur.modelPicker = prev.modelPicker;
          else delete cur.modelPicker;
        } else {
          delete cur.effortLevel;
          delete cur.modelPicker;
        }
        if (cur.env && typeof cur.env === "object") {
          const managedKeys = [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "CLAUDE_CODE_EFFORT_LEVEL",
            "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
          ];
          for (const k of managedKeys) {
            const prevVal = prev?.envKeys?.[k];
            if (prevVal !== null && prevVal !== undefined) cur.env[k] = prevVal;
            else if (k !== "ANTHROPIC_API_KEY" || cur.env.ANTHROPIC_API_KEY === "") {
              delete cur.env[k];
            }
          }
          if (Object.keys(cur.env).length === 0) delete cur.env;
        }
        if (!keepAdditive) unlinkBak(fp);
        if (Object.keys(cur).length === 0 && (!prev || !prev.existed)) {
          assertNotSymlink(fp);
          fs.unlinkSync(fp);
        } else {
          writePrivateFile(fp, JSON.stringify(cur, null, 2) + "\n", 0o600);
        }
        touched.push(fp);
      }
    }
    if (!keepAdditive) {
      const side = path.join(hallpassDir(homeDir), "claude-settings.json");
      const shim = path.join(hallpassDir(homeDir), "bin", "claude-hp");
      for (const p of [side, shim]) {
        if (fs.existsSync(p)) {
          assertNotSymlink(p);
          fs.unlinkSync(p);
          touched.push(p);
        }
      }
      removeIfEmptyDir(path.join(hallpassDir(homeDir), "bin"));
      removeIfEmptyDir(path.join(homeDir, ".claude"));
    }
  } else if (a === "codex") {
    const codexDir = resolveCodexDir(homeDir);
    const fp = path.join(codexDir, "config.toml");
    if (fs.existsSync(fp)) {
      assertNotSymlink(fp);
      const raw = fs.readFileSync(fp, "utf8");
      if (keepAdditive) {
        // Keep `[model_providers.hallpass]` dormant, restore root keys only
        const strippedRoot = stripHallpassFromCodexToml(raw, {
          removeTopLevelProvider: true,
        });
        const helperPath = helperScriptPath(homeDir);
        const restoredRootLines = [
          prev?.modelLine,
          prev?.providerLine,
          prev?.reasoningLine,
          prev?.webSearchLine,
        ].filter(Boolean);
        const baseToml = mergeCodexRestoredRootLines(restoredRootLines, strippedRoot).trim();
        const withProvider = upsertCodexToml(baseToml, {
          model: "gpt-6.1-sol",
          apiBase:
            savedEntry?.apiBase ||
            readStoredCredentials(homeDir).keys?.codex?.apiBase ||
            "https://api.hallpassai.com/v1",
          nodePath: process.execPath,
          helperPath,
          providerOnly: true,
        });
        writePrivateFile(fp, withProvider, 0o600);
      } else {
        const cleaned = stripHallpassFromCodexToml(raw, {
          removeTopLevelProvider: true,
        });
        const restoredRootLines = [
          prev?.modelLine,
          prev?.providerLine,
          prev?.reasoningLine,
          prev?.webSearchLine,
        ].filter(Boolean);
        const merged = mergeCodexRestoredRootLines(restoredRootLines, cleaned);
        unlinkBak(fp);
        if (!merged.trim() && (!prev || !prev.existed)) {
          fs.unlinkSync(fp);
        } else {
          writePrivateFile(fp, merged, 0o600);
        }
      }
      touched.push(fp);
    }
    if (!keepAdditive) {
      const prof = path.join(codexDir, "hallpass.config.toml");
      const shim = path.join(hallpassDir(homeDir), "bin", "codex-hp");
      for (const p of [prof, shim]) {
        if (fs.existsSync(p)) {
          assertNotSymlink(p);
          fs.unlinkSync(p);
          touched.push(p);
        }
      }
      removeIfEmptyDir(path.join(hallpassDir(homeDir), "bin"));
      removeIfEmptyDir(codexDir);
    }
  } else if (a === "opencode") {
    const { configDir: cfgDir, dataDir } = resolveOpencodeDirs(homeDir);
    const cfgPath = path.join(cfgDir, "opencode.json");
    const authPath = path.join(dataDir, "auth.json");
    if (fs.existsSync(cfgPath)) {
      const cur = readJsonSafe(cfgPath);
      if (prev?.previousModel) cur.model = prev.previousModel;
      else if (typeof cur.model === "string" && cur.model.startsWith("hallpass/")) {
        delete cur.model;
      }
      if (!keepAdditive) {
        if (cur.provider && typeof cur.provider === "object") {
          delete cur.provider.hallpass;
          if (Object.keys(cur.provider).length === 0) delete cur.provider;
        }
        unlinkBak(cfgPath);
      }
      const meaningfulKeys = Object.keys(cur).filter((k) => k !== "$schema");
      if (!keepAdditive && meaningfulKeys.length === 0 && (!prev || !prev.existed)) {
        assertNotSymlink(cfgPath);
        fs.unlinkSync(cfgPath);
      } else {
        writePrivateFile(cfgPath, JSON.stringify(cur, null, 2) + "\n", 0o600);
      }
      touched.push(cfgPath);
    }
    if (!keepAdditive && fs.existsSync(authPath)) {
      const curAuth = readJsonSafe(authPath);
      delete curAuth.hallpass;
      unlinkBak(authPath);
      if (Object.keys(curAuth).length === 0) {
        assertNotSymlink(authPath);
        fs.unlinkSync(authPath);
      } else {
        writePrivateFile(authPath, JSON.stringify(curAuth, null, 2) + "\n", 0o600);
      }
      touched.push(authPath);
    }
    if (!keepAdditive) {
      removeIfEmptyDir(cfgDir);
      removeIfEmptyDir(dataDir);
    }
  } else if (a === "copilot") {
    const envPath = path.join(hallpassDir(homeDir), "copilot.env");
    const fishEnvPath = path.join(hallpassDir(homeDir), "copilot.fish");
    if (!keepAdditive) {
      for (const p of [envPath, fishEnvPath]) {
        if (fs.existsSync(p)) {
          assertNotSymlink(p);
          fs.unlinkSync(p);
          touched.push(p);
        }
      }
    }
    if (!keepAdditive) {
      const shim = path.join(hallpassDir(homeDir), "bin", "copilot-hp");
      if (fs.existsSync(shim)) {
        assertNotSymlink(shim);
        fs.unlinkSync(shim);
        touched.push(shim);
      }
      removeIfEmptyDir(path.join(hallpassDir(homeDir), "bin"));
    }
    const { rcPath: primaryRc } = resolveShellRcTarget(homeDir, shell);
    const candidateRcs = Array.from(
      new Set([
        primaryRc,
        path.join(homeDir, ".zshrc"),
        path.join(homeDir, ".bashrc"),
        path.join(homeDir, ".bash_profile"),
        path.join(homeDir, ".config", "fish", "config.fish"),
      ]),
    );
    for (const rcPath of candidateRcs) {
      if (fs.existsSync(rcPath)) {
        assertNotSymlink(rcPath);
        const raw = fs.readFileSync(rcPath, "utf8");
        if (raw.includes(SHELL_START)) {
          const cleaned = raw
            .replace(
              new RegExp(`\\n?${SHELL_START}[\\s\\S]*?${SHELL_END}\\n?`, "g"),
              "\n",
            )
            .trimEnd();
          const rcMode = fs.statSync(rcPath).mode & 0o777 || 0o600;
          if (!keepAdditive) unlinkBak(rcPath);
          if (!cleaned) {
            fs.unlinkSync(rcPath);
          } else {
            writePrivateFile(rcPath, cleaned + "\n", rcMode);
          }
          touched.push(rcPath);
        }
      }
    }
  }
  return touched;
}

export function pauseAgent(
  agent = "all",
  { homeDir = os.homedir(), shell = process.env.SHELL || "/bin/zsh" } = {},
) {
  const creds = readStoredCredentials(homeDir);
  const targets =
    agent === "all"
      ? Object.keys(creds.keys || {})
      : creds.keys?.[agent]
        ? [agent]
        : [];
  const updated = [];
  for (const a of targets) {
    const info = creds.keys[a];
    if (!info) continue;
    if (a === "cursor") {
      updated.push({
        agent: a,
        files: [],
        manual: true,
        note: "Turn off Override OpenAI Base URL in Cursor → Settings → Models to pause HallPass.",
      });
      continue;
    }
    const files = surgicallyRestoreGlobalConfig(a, {
      homeDir,
      shell,
      keepAdditive: true,
      savedEntry: info,
    });
    storeCredential(
      a,
      {
        token: info.token,
        apiBase: info.apiBase,
        model: info.model,
        reasoning: info.reasoning || null,
        mode: info.mode || "default",
        paused: true,
      },
      { homeDir },
    );
    updated.push({ agent: a, files });
  }
  return updated;
}

export function resumeAgent(
  agent = "all",
  {
    homeDir = os.homedir(),
    shell = process.env.SHELL || "/bin/zsh",
    catalogModels = [],
  } = {},
) {
  const creds = readStoredCredentials(homeDir);
  const targets =
    agent === "all"
      ? Object.keys(creds.keys || {})
      : creds.keys?.[agent]
        ? [agent]
        : [];
  const updated = [];
  for (const a of targets) {
    const info = creds.keys[a];
    if (!info?.token || !info?.apiBase) continue;
    const res = configureAgent(
      a,
      {
        token: info.token,
        apiBase: info.apiBase,
        model: info.model,
        models: catalogModels.length
          ? catalogModels
          : [
              {
                id: info.model,
                name: info.model,
                protocols: ["messages", "responses", "chat/completions"],
              },
            ],
      },
      {
        homeDir,
        shell,
        dryRun: false,
        reasoningEffort: info.reasoning || null,
        mode: info.mode || "default",
      },
    );
    updated.push({ agent: a, model: res.appliedModel || info.model, files: res.files });
  }
  return updated;
}

export function undoAgent(
  agent = "all",
  {
    homeDir = os.homedir(),
    shell = process.env.SHELL || "/bin/zsh",
    fullCleanup = false,
  } = {},
) {
  const targets = agent === "all" ? SUPPORTED_AGENTS : [agent];
  const restored = [];
  const removeIfEmptyDir = (dirPath) => {
    try {
      if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
        fs.rmdirSync(dirPath);
      }
    } catch {}
  };

  const existingCreds = readStoredCredentials(homeDir).keys || {};
  for (const a of targets) {
    const savedEntry = existingCreds[a] || null;
    removeCredential(a, { homeDir });
    const touched = surgicallyRestoreGlobalConfig(a, {
      homeDir,
      shell,
      keepAdditive: false,
      savedEntry,
    });
    for (const f of touched) {
      if (!restored.includes(f)) restored.push(f);
    }
    clearPreviousAgentState(a, homeDir);
  }

  const remainingKeys = Object.keys(readStoredCredentials(homeDir).keys || {});
  if (fullCleanup && remainingKeys.length === 0) {
    for (const removedFile of purgeHallpassDir(homeDir)) {
      if (!restored.includes(removedFile)) restored.push(removedFile);
    }
  } else if (remainingKeys.length === 0) {
    for (const fn of [
      "copilot.env",
      "copilot.fish",
      "claude-settings.json",
      "previous-state.json",
      "read-key.mjs",
      "credentials.json",
    ]) {
      const fp = path.join(hallpassDir(homeDir), fn);
      if (fs.existsSync(fp)) {
        assertNotSymlink(fp);
        fs.unlinkSync(fp);
      }
    }
    removeIfEmptyDir(path.join(hallpassDir(homeDir), "bin"));
    removeIfEmptyDir(hallpassDir(homeDir));
  }

  return restored;
}

export function inspectAgentConfig(
  agent,
  { homeDir = os.homedir(), shell = process.env.SHELL || "/bin/zsh" } = {},
) {
  try {
    const creds = readStoredCredentials(homeDir);
    const saved = creds.keys?.[agent] || null;
    if (saved?.paused) {
      return {
        ok: true,
        paused: true,
        configPath: agent,
        diskModel: saved.model || null,
        diskReasoning: saved.reasoning || null,
        note: "paused (`npx hallpassai resume` to re-enable as default)",
      };
    }
    if (agent === "claude-code") {
      if (saved?.mode === "coexist") {
        const side = path.join(hallpassDir(homeDir), "claude-settings.json");
        const cfg = readJsonSafe(side);
        const ok = Boolean(
          cfg?.env?.ANTHROPIC_BASE_URL && cfg?.env?.ANTHROPIC_AUTH_TOKEN,
        );
        return {
          ok,
          configPath: side,
          diskModel: cfg?.env?.ANTHROPIC_MODEL || null,
          diskReasoning: cfg?.effortLevel || null,
          note: ok
            ? "coexist mode (`claude-hp` / `npx hallpassai run claude`)"
            : "claude-settings.json missing",
        };
      }
      const fp = path.join(homeDir, ".claude", "settings.json");
      const cfg = readJsonSafe(fp);
      const ok = Boolean(
        cfg?.env?.ANTHROPIC_BASE_URL && cfg?.env?.ANTHROPIC_AUTH_TOKEN,
      );
      return {
        ok,
        configPath: fp,
        diskModel: cfg?.env?.ANTHROPIC_MODEL || null,
        diskReasoning: cfg?.effortLevel || null,
        note: ok
          ? "settings.json wired to HallPass"
          : "settings.json missing HallPass env",
      };
    }
    if (agent === "codex") {
      const codexDir = resolveCodexDir(homeDir);
      const fp = path.join(codexDir, "config.toml");
      const prof = path.join(codexDir, "hallpass.config.toml");
      const raw = fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : "";
      const helper = helperScriptPath(homeDir);
      if (saved?.mode === "coexist" && fs.existsSync(prof)) {
        const pRaw = fs.readFileSync(prof, "utf8");
        const ok =
          raw.includes("[model_providers.hallpass]") && fs.existsSync(helper);
        const mMatch = pRaw.match(/^\s*model\s*=\s*"([^"]+)"/m);
        const rMatch = pRaw.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
        return {
          ok,
          configPath: prof,
          diskModel: mMatch ? mMatch[1] : null,
          diskReasoning: rMatch ? rMatch[1] : null,
          note: ok
            ? "coexist profile (`codex -p hallpass`)"
            : "hallpass.config.toml or read-key.mjs missing",
        };
      }
      const rawLines = raw.replace(/\r\n/g, "\n").split("\n");
      const firstSec = rawLines.findIndex((l) => TOML_HEADER_RE.test(l));
      const rootToml = rawLines
        .slice(0, firstSec === -1 ? rawLines.length : firstSec)
        .join("\n");
      const ok =
        rootToml.includes('model_provider = "hallpass"') && fs.existsSync(helper);
      const mMatch = rootToml.match(/^\s*model\s*=\s*"([^"]+)"/m);
      const rMatch = rootToml.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
      return {
        ok,
        configPath: fp,
        diskModel: mMatch ? mMatch[1] : null,
        diskReasoning: rMatch ? rMatch[1] : null,
        note: ok
          ? "config.toml + credential helper present"
          : "config.toml or read-key.mjs missing",
      };
    }
    if (agent === "opencode") {
      const { configDir, dataDir } = resolveOpencodeDirs(homeDir);
      const cfgPath = path.join(configDir, "opencode.json");
      const authPath = path.join(dataDir, "auth.json");
      const cfg = readJsonSafe(cfgPath);
      const auth = readJsonSafe(authPath);
      const ok = Boolean(cfg?.provider?.hallpass && auth?.hallpass?.key);
      const diskModel =
        typeof cfg?.model === "string" && cfg.model.startsWith("hallpass/")
          ? cfg.model.slice("hallpass/".length)
          : saved?.model || null;
      const diskReasoning =
        (diskModel &&
          cfg?.provider?.hallpass?.models?.[diskModel]?.options
            ?.reasoningEffort) ||
        null;
      return {
        ok,
        configPath: cfgPath,
        diskModel,
        diskReasoning,
        note: ok
          ? saved?.mode === "coexist"
            ? "opencode.json provider registered (coexist mode)"
            : "opencode.json + auth.json wired to HallPass"
          : "opencode config or auth missing",
      };
    }
    if (agent === "copilot") {
      const envPath = path.join(hallpassDir(homeDir), "copilot.env");
      const envRaw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
      const mMatch = envRaw.match(/COPILOT_MODEL='([^']+)'/);
      if (saved?.mode === "coexist") {
        const shim = path.join(hallpassDir(homeDir), "bin", "copilot-hp");
        const ok = fs.existsSync(envPath) && fs.existsSync(shim);
        return {
          ok,
          configPath: envPath,
          diskModel: mMatch ? mMatch[1] : null,
          diskReasoning: null,
          note: ok
            ? "coexist mode (`copilot-hp` / `npx hallpassai run copilot`)"
            : "copilot.env or copilot-hp shim missing",
        };
      }
      const { rcPath } = resolveShellRcTarget(homeDir, shell);
      const rcRaw = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf8") : "";
      const ok = fs.existsSync(envPath) && rcRaw.includes(SHELL_START);
      return {
        ok,
        configPath: envPath,
        diskModel: mMatch ? mMatch[1] : null,
        diskReasoning: null,
        note: ok
          ? `copilot.env + ${path.basename(rcPath)} profile block active`
          : "copilot.env or shell profile block missing",
      };
    }
    if (agent === "cursor") {
      const ok = Boolean(saved?.token);
      return {
        ok,
        configPath: "Cursor → Settings → Models",
        diskModel: saved?.model || null,
        diskReasoning: null,
        note: ok
          ? "Credentials saved locally (set in Cursor → Settings → Models)"
          : "No stored Cursor credentials",
      };
    }
  } catch (err) {
    return { ok: false, configPath: agent, note: err.message };
  }
  return { ok: false, configPath: agent, note: "Unknown tool" };
}

export function switchAgentModel(
  agent,
  newModel,
  {
    homeDir = os.homedir(),
    shell = process.env.SHELL || "/bin/zsh",
    reasoningEffort = null,
    catalogModels = null,
  } = {},
) {
  const creds = readStoredCredentials(homeDir);
  const entry = creds.keys?.[agent];
  if (!entry?.token || !entry?.apiBase) {
    throw new Error(
      `${agent} is not configured yet. Pair it first at https://app.hallpassai.com/start.html#connect`,
    );
  }
  const effectiveModel = newModel || entry.model;
  const effectiveReasoning =
    reasoningEffort !== null && reasoningEffort !== undefined
      ? reasoningEffort
      : entry.reasoning || null;
  const modelsList =
    Array.isArray(catalogModels) && catalogModels.length
      ? catalogModels
      : [
          {
            id: effectiveModel,
            name: effectiveModel,
            protocols: ["messages", "responses", "chat/completions"],
          },
        ];
  return configureAgent(
    agent,
    {
      token: entry.token,
      apiBase: entry.apiBase,
      model: effectiveModel,
      models: modelsList,
    },
    {
      homeDir,
      shell,
      dryRun: false,
      reasoningEffort: effectiveReasoning,
      mode: entry.mode || "default",
    },
  );
}
