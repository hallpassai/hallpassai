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
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];
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
    } else if (c === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      if (i < raw.length) out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
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
  { model, apiBase, nodePath, helperPath, reasoningEffort = null },
) {
  const kept = stripHallpassFromCodexToml(existingToml);
  const codexEff =
    reasoningEffort &&
    ["none", "minimal", "low", "medium", "high", "xhigh"].includes(reasoningEffort)
      ? reasoningEffort
      : null;

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

  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const block = [
    ...(kept.length ? [""] : []),
    "[model_providers.hallpass]",
    `name = "HallPass"`,
    `base_url = ${tomlBasicString(apiBase)}`,
    `wire_api = "responses"`,
    "",
    "[model_providers.hallpass.auth]",
    `command = ${tomlBasicString(nodePath)}`,
    `args = [${tomlBasicString(helperPath)}, "codex"]`,
    `timeout_ms = 3000`,
    "",
  ];
  return [...kept, ...block].join("\n");
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
    ? `test -f ${qPath}; and bass source ${qPath} 2>/dev/null`
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

export function configureAgent(
  agent,
  payload,
  {
    homeDir = os.homedir(),
    dryRun = false,
    nodePath = process.execPath,
    shell = process.env.SHELL || "/bin/zsh",
    reasoningEffort = null,
  } = {},
) {
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
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const current = readJsonSafe(settingsPath);
    const wasManagedByHallpass = Boolean(
      current?.env?.ANTHROPIC_BASE_URL && current?.env?.ANTHROPIC_AUTH_TOKEN,
    );
    const claudeModels = models.filter(
      (m) =>
        m.protocols?.includes("messages") &&
        (m.provider === "Anthropic" || /^claude[-_]/i.test(m.id)),
    );
    const chosenClaude =
      claudeModels.find((m) => m.id === model)?.id ||
      claudeModels[0]?.id ||
      models.find((m) => m.id === model && m.protocols?.includes("messages"))
        ?.id ||
      models.find((m) => m.protocols?.includes("messages"))?.id ||
      model;
    const defaultOpus = claudeModels.find((m) => /opus/i.test(m.id))?.id;
    const defaultSonnet = claudeModels.find((m) => /sonnet/i.test(m.id))?.id;
    const defaultHaiku = claudeModels.find((m) => /haiku/i.test(m.id))?.id;
    const mappedClaudeEffort =
      normEffort === "xhigh"
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

    const hasNonHallpassClaudeKeys = (() => {
      const probe = structuredClone(current);
      if (wasManagedByHallpass) delete probe.effortLevel;
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
    const nextEnv = {
      ...(current.env && typeof current.env === "object" ? current.env : {}),
      ANTHROPIC_BASE_URL: anthropicBase,
      ANTHROPIC_AUTH_TOKEN: effectiveToken,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: chosenClaude,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ...(defaultOpus ? { ANTHROPIC_DEFAULT_OPUS_MODEL: defaultOpus } : {}),
      ...(defaultSonnet ? { ANTHROPIC_DEFAULT_SONNET_MODEL: defaultSonnet } : {}),
      ...(defaultHaiku ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: defaultHaiku } : {}),
    };
    // Never write env.CLAUDE_CODE_EFFORT_LEVEL because it locks session effort and blocks live `/effort` switching.
    delete nextEnv.CLAUDE_CODE_EFFORT_LEVEL;

    const next = {
      ...current,
      ...(claudeEffort ? { effortLevel: claudeEffort } : {}),
      env: nextEnv,
    };
    if (!claudeEffort && Object.hasOwn(next, "effortLevel")) {
      delete next.effortLevel;
    }
    const content = JSON.stringify(next, null, 2) + "\n";
    if (!dryRun) {
      storeCredential(
        "claude-code",
        { token, apiBase, model: chosenClaude, reasoning: claudeEffort },
        { homeDir },
      );
      const backup = hasNonHallpassClaudeKeys
        ? backupOnce(settingsPath, { secret: true })
        : null;
      writePrivateFile(settingsPath, content, 0o600);
      return {
        agent,
        appliedModel: chosenClaude,
        appliedReasoning: claudeEffort,
        files: [settingsPath],
        backup,
        nextStep: "Run `claude` in this terminal (switch models & effort anytime with `/model` and `/effort`).",
      };
    }
    return {
      agent,
      appliedModel: chosenClaude,
      appliedReasoning: claudeEffort,
      files: [settingsPath],
      preview: content,
    };
  }

  if (agent === "codex") {
    const configPath = path.join(homeDir, ".codex", "config.toml");
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
      openAiResponses.find((m) => m.id === model)?.id ||
      openAiResponses[0]?.id ||
      models.find((m) => m.id === model && m.protocols?.includes("responses"))
        ?.id ||
      models.find((m) => m.protocols?.includes("responses"))?.id ||
      model;
    const rawCodexEff =
      rawEffort === "none"
        ? "none"
        : normEffort && ["minimal", "low", "medium", "high", "xhigh"].includes(normEffort)
          ? normEffort
          : normEffort === "max"
            ? "xhigh"
            : null;
    const codexEffort =
      rawCodexEff && supportsReasoningId(compatible) ? rawCodexEff : null;
    const content = upsertCodexToml(existing, {
      model: compatible,
      apiBase,
      nodePath,
      helperPath,
      reasoningEffort: codexEffort,
    });
    if (!dryRun) {
      storeCredential(
        "codex",
        { token, apiBase, model: compatible, reasoning: codexEffort },
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
        appliedModel: compatible,
        appliedReasoning: codexEffort,
        files: [configPath, helperPath],
        backup,
        nextStep: 'Run `codex` (override reasoning anytime with `codex -c model_reasoning_effort="high"`).',
      };
    }
    return {
      agent,
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
        : normEffort === "max" || normEffort === "xhigh"
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
    // Preserve previously configured catalog models when offline (`models` only has 1 fallback item)
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
      const canReason = Boolean(m.reasoning || supportsReasoningId(m.id));
      const prevEntry = modelEntries[m.id];
      const ctxLimit =
        Number.isInteger(m.contextLength) && m.contextLength > 0
          ? m.contextLength
          : Number.isInteger(prevEntry?.limit?.context) && prevEntry.limit.context > 0
            ? prevEntry.limit.context
            : 128000;
      modelEntries[m.id] = {
        name: m.name || prevEntry?.name || m.id,
        tool_call: true,
        ...(canReason ? { reasoning: true } : {}),
        limit: { context: ctxLimit, output: 8192 },
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

    const nextCfg = {
      $schema: currentCfg.$schema || "https://opencode.ai/config.json",
      ...currentCfg,
      model: `hallpass/${chosenModel}`,
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
      storeCredential(
        "opencode",
        { token, apiBase, model: chosenModel, reasoning: ocEffort },
        { homeDir },
      );
      const hasOtherProvider = Boolean(
        Object.keys(currentCfg).some((k) => !["$schema", "model", "provider"].includes(k)) ||
          Object.keys(currentCfg.provider || {}).some((p) => p !== "hallpass") ||
          (typeof currentCfg.model === "string" && !currentCfg.model.startsWith("hallpass/")),
      );
      const hasOtherAuth = Object.keys(currentAuth).some((k) => k !== "hallpass");
      const backup = hasOtherProvider ? backupOnce(configPath) : null;
      if (hasOtherAuth) backupOnce(authPath, { secret: true });
      writePrivateFile(configPath, cfgContent, 0o600);
      writePrivateFile(authPath, authContent, 0o600);
      return {
        agent,
        appliedModel: chosenModel,
        appliedReasoning: ocEffort,
        files: [configPath, authPath],
        backup,
        nextStep: "Run `opencode` in this terminal and send your first prompt.",
      };
    }
    return {
      agent,
      appliedModel: chosenModel,
      appliedReasoning: ocEffort,
      files: [configPath, authPath],
      preview: cfgContent,
    };
  }

  if (agent === "copilot") {
    const dir = hallpassDir(homeDir);
    const envPath = path.join(dir, "copilot.env");
    const chosenModel =
      models.find(
        (m) => m.id === model && m.protocols?.includes("chat/completions"),
      )?.id ||
      models.find((m) => m.protocols?.includes("chat/completions"))?.id ||
      model;
    const envContent = [
      `# HallPass configuration for GitHub Copilot CLI`,
      `export COPILOT_OFFLINE='true'`,
      `export COPILOT_PROVIDER_TYPE='openai'`,
      `export COPILOT_PROVIDER_BASE_URL=${shSingleQuote(apiBase)}`,
      `export COPILOT_PROVIDER_API_KEY=${shSingleQuote(effectiveToken)}`,
      `export COPILOT_MODEL=${shSingleQuote(chosenModel)}`,
      `export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS='8192'`,
      "",
    ].join("\n");

    const rcPath = shell.includes("bash")
      ? path.join(homeDir, ".bashrc")
      : path.join(homeDir, ".zshrc");
    assertNotSymlink(rcPath);
    const existingRc = fs.existsSync(rcPath)
      ? fs.readFileSync(rcPath, "utf8")
      : "";
    const nextRc = upsertShellBlock(existingRc, envPath, false);

    if (!dryRun) {
      storeCredential("copilot", { token, apiBase, model: chosenModel }, { homeDir });
      writePrivateFile(envPath, envContent, 0o600);
      const nonHallpassRc = existingRc
        .replace(new RegExp(`\\n?${SHELL_START}[\\s\\S]*?${SHELL_END}\\n?`, "g"), "")
        .trim();
      const backup = nonHallpassRc ? backupOnce(rcPath) : null;
      const rcMode = fs.existsSync(rcPath)
        ? fs.statSync(rcPath).mode & 0o777 || 0o644
        : 0o644;
      writePrivateFile(rcPath, nextRc, rcMode);
      return {
        agent,
        appliedModel: chosenModel,
        appliedReasoning: null,
        files: [envPath, rcPath],
        backup,
        nextStep: `Run \`source ${shSingleQuote(envPath)} && copilot\` in this terminal (new terminals load it automatically).`,
      };
    }
    return {
      agent,
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
      storeCredential("cursor", { token, apiBase, model: chosenModel }, { homeDir });
    }
    return {
      agent,
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

  const restoreBak = (fp, { secret = false } = {}) => {
    const bak = `${fp}.hallpass.bak`;
    if (fs.existsSync(bak)) {
      assertNotSymlink(bak);
      assertNotSymlink(fp);
      const mode = secret ? 0o600 : fs.statSync(bak).mode & 0o777 || 0o600;
      writePrivateFile(fp, fs.readFileSync(bak), mode);
      fs.unlinkSync(bak);
      restored.push(fp);
      return true;
    }
    return false;
  };

  const removeIfEmptyDir = (dirPath) => {
    try {
      if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
        fs.rmdirSync(dirPath);
      }
    } catch {}
  };

  for (const a of targets) {
    removeCredential(a, { homeDir });
    if (a === "claude-code") {
      const fp = path.join(homeDir, ".claude", "settings.json");
      if (!restoreBak(fp, { secret: true }) && fs.existsSync(fp)) {
        const cur = readJsonSafe(fp);
        delete cur.effortLevel;
        if (cur.env && typeof cur.env === "object") {
          delete cur.env.ANTHROPIC_BASE_URL;
          delete cur.env.ANTHROPIC_AUTH_TOKEN;
          delete cur.env.ANTHROPIC_MODEL;
          delete cur.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
          delete cur.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
          delete cur.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
          delete cur.env.CLAUDE_CODE_EFFORT_LEVEL;
          if (cur.env.ANTHROPIC_API_KEY === "") delete cur.env.ANTHROPIC_API_KEY;
          delete cur.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
          delete cur.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
          if (!Object.keys(cur.env).length) delete cur.env;
        }
        if (!Object.keys(cur).length) {
          fs.unlinkSync(fp);
        } else {
          writePrivateFile(fp, JSON.stringify(cur, null, 2) + "\n", 0o600);
        }
        restored.push(fp);
      }
      removeIfEmptyDir(path.join(homeDir, ".claude"));
    } else if (a === "codex") {
      const fp = path.join(homeDir, ".codex", "config.toml");
      if (!restoreBak(fp, { secret: true }) && fs.existsSync(fp)) {
        assertNotSymlink(fp);
        const cleaned = stripHallpassFromCodexToml(
          fs.readFileSync(fp, "utf8"),
          { removeTopLevelProvider: true },
        );
        if (!cleaned.trim()) {
          fs.unlinkSync(fp);
        } else {
          writePrivateFile(fp, cleaned, 0o600);
        }
        restored.push(fp);
      }
      removeIfEmptyDir(path.join(homeDir, ".codex"));
    } else if (a === "opencode") {
      const { configDir: cfgDir, dataDir } = resolveOpencodeDirs(homeDir);
      const cfgPath = path.join(cfgDir, "opencode.json");
      const authPath = path.join(dataDir, "auth.json");
      if (!restoreBak(cfgPath) && fs.existsSync(cfgPath)) {
        const cur = readJsonSafe(cfgPath);
        if (cur.provider && typeof cur.provider === "object") {
          delete cur.provider.hallpass;
          if (!Object.keys(cur.provider).length) delete cur.provider;
        }
        if (typeof cur.model === "string" && cur.model.startsWith("hallpass/")) {
          delete cur.model;
        }
        const keysLeft = Object.keys(cur).filter((k) => k !== "$schema");
        if (!keysLeft.length) {
          fs.unlinkSync(cfgPath);
        } else {
          writePrivateFile(cfgPath, JSON.stringify(cur, null, 2) + "\n", 0o600);
        }
        restored.push(cfgPath);
      }
      if (!restoreBak(authPath, { secret: true }) && fs.existsSync(authPath)) {
        const auth = readJsonSafe(authPath);
        delete auth.hallpass;
        if (!Object.keys(auth).length) {
          fs.unlinkSync(authPath);
        } else {
          writePrivateFile(authPath, JSON.stringify(auth, null, 2) + "\n", 0o600);
        }
        restored.push(authPath);
      }
      removeIfEmptyDir(cfgDir);
      removeIfEmptyDir(dataDir);
    } else if (a === "copilot") {
      const envPath = path.join(hallpassDir(homeDir), "copilot.env");
      if (fs.existsSync(envPath)) {
        assertNotSymlink(envPath);
        fs.unlinkSync(envPath);
        restored.push(envPath);
      }
      const primaryRc = shell.includes("bash")
        ? path.join(homeDir, ".bashrc")
        : path.join(homeDir, ".zshrc");
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
        if (!restoreBak(rcPath) && fs.existsSync(rcPath)) {
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
            writePrivateFile(rcPath, cleaned ? cleaned + "\n" : "", rcMode);
            restored.push(rcPath);
          }
        }
      }
    }
  }

  const remainingKeys = Object.keys(readStoredCredentials(homeDir).keys || {});
  if (fullCleanup && agent === "all") {
    for (const removedFile of purgeHallpassDir(homeDir)) {
      if (!restored.includes(removedFile)) restored.push(removedFile);
    }
  } else if (agent === "all" && remainingKeys.length === 0) {
    // Remove helper script & empty credentials file while keeping anonymous telemetry ID intact on light undo.
    for (const fn of ["copilot.env", "read-key.mjs", "credentials.json"]) {
      const fp = path.join(hallpassDir(homeDir), fn);
      if (fs.existsSync(fp)) {
        assertNotSymlink(fp);
        fs.unlinkSync(fp);
      }
    }
    removeIfEmptyDir(hallpassDir(homeDir));
  }

  return restored;
}

export function inspectAgentConfig(
  agent,
  { homeDir = os.homedir(), shell = process.env.SHELL || "/bin/zsh" } = {},
) {
  try {
    if (agent === "claude-code") {
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
      const fp = path.join(homeDir, ".codex", "config.toml");
      const raw = fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : "";
      const helper = helperScriptPath(homeDir);
      const ok =
        raw.includes('model_provider = "hallpass"') && fs.existsSync(helper);
      const mMatch = raw.match(/^\s*model\s*=\s*"([^"]+)"/m);
      const rMatch = raw.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
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
          : null;
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
          ? "opencode.json + auth.json wired to HallPass"
          : "opencode config or auth missing",
      };
    }
    if (agent === "copilot") {
      const envPath = path.join(hallpassDir(homeDir), "copilot.env");
      const rcPath = shell.includes("bash")
        ? path.join(homeDir, ".bashrc")
        : path.join(homeDir, ".zshrc");
      const rcRaw = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf8") : "";
      const envRaw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
      const ok = fs.existsSync(envPath) && rcRaw.includes(SHELL_START);
      const mMatch = envRaw.match(/COPILOT_MODEL='([^']+)'/);
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
      const creds = readStoredCredentials(homeDir);
      const ok = Boolean(creds.keys?.cursor?.token);
      return {
        ok,
        configPath: "Cursor → Settings → Models",
        diskModel: creds.keys?.cursor?.model || null,
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
    { homeDir, shell, dryRun: false, reasoningEffort: effectiveReasoning },
  );
}
