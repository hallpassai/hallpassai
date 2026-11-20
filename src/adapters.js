import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  assertNotSymlink,
  hallpassDir,
  helperScriptPath,
  storeCredential,
  removeCredential,
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

function stripHallpassFromCodexToml(existingToml, { removeTopLevelProvider = false } = {}) {
  const lines = existingToml
    ? existingToml.replace(/\r\n/g, "\n").split("\n")
    : [];
  const kept = [];
  let skippingHallpass = false;
  for (const line of lines) {
    const header = line.match(TOML_HEADER_RE);
    if (header) {
      const name = header[2].trim();
      skippingHallpass =
        name === "model_providers.hallpass" ||
        name.startsWith("model_providers.hallpass.");
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
          (hadHallpassProvider && /^\s*model\s*=/.test(kept[i])))
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
  { model, apiBase, nodePath, helperPath },
) {
  const kept = stripHallpassFromCodexToml(existingToml);

  // Update or insert top-level `model` and `model_provider` BEFORE the first `[section]` / `[[array]]`.
  const firstSectionIdx = kept.findIndex((l) => TOML_HEADER_RE.test(l));
  const limit = firstSectionIdx === -1 ? kept.length : firstSectionIdx;
  let sawModel = false;
  let sawProvider = false;
  for (let i = 0; i < limit; i++) {
    if (/^\s*model\s*=/.test(kept[i])) {
      kept[i] = `model = ${tomlBasicString(model)}`;
      sawModel = true;
    } else if (/^\s*model_provider\s*=/.test(kept[i])) {
      kept[i] = `model_provider = "hallpass"`;
      sawProvider = true;
    }
  }
  const topInserts = [];
  if (!sawModel) topInserts.push(`model = ${tomlBasicString(model)}`);
  if (!sawProvider) topInserts.push(`model_provider = "hallpass"`);
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
  } = {},
) {
  const { token, apiBase, model, models = [] } = payload;
  const effectiveToken = dryRun ? "hp_live_••••••••" : token;
  const anthropicBase = apiBase.replace(/\/v1\/?$/, "");

  if (agent === "claude-code") {
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const current = readJsonSafe(settingsPath);
    const next = {
      ...current,
      env: {
        ...(current.env && typeof current.env === "object" ? current.env : {}),
        ANTHROPIC_BASE_URL: anthropicBase,
        ANTHROPIC_AUTH_TOKEN: effectiveToken,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: model,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      },
    };
    const content = JSON.stringify(next, null, 2) + "\n";
    if (!dryRun) {
      storeCredential("claude-code", { token, apiBase, model }, { homeDir });
      const backup = backupOnce(settingsPath, { secret: true });
      writePrivateFile(settingsPath, content, 0o600);
      return {
        agent,
        files: [settingsPath],
        backup,
        nextStep: "Run `claude` in this terminal and send your first prompt.",
      };
    }
    return { agent, files: [settingsPath], preview: content };
  }

  if (agent === "codex") {
    const configPath = path.join(homeDir, ".codex", "config.toml");
    assertNotSymlink(configPath);
    const existing = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8")
      : "";
    const helperPath = helperScriptPath(homeDir);
    const compatible =
      models.find((m) => m.id === model && m.protocols?.includes("responses"))
        ?.id ||
      models.find((m) => m.protocols?.includes("responses"))?.id ||
      model;
    const content = upsertCodexToml(existing, {
      model: compatible,
      apiBase,
      nodePath,
      helperPath,
    });
    if (!dryRun) {
      storeCredential("codex", { token, apiBase, model: compatible }, { homeDir });
      const backup = backupOnce(configPath, { secret: true });
      writePrivateFile(configPath, content, 0o600);
      return {
        agent,
        files: [configPath, helperPath],
        backup,
        nextStep: "Run `codex` in this terminal and send your first prompt.",
      };
    }
    return { agent, files: [configPath], preview: content };
  }

  if (agent === "opencode") {
    const { configDir, dataDir } = resolveOpencodeDirs(homeDir);
    const configPath = path.join(configDir, "opencode.json");
    const authPath = path.join(dataDir, "auth.json");

    const chatModels = models.filter((m) =>
      m.protocols?.includes("chat/completions"),
    );
    const chosenModel =
      chatModels.find((m) => m.id === model)?.id ||
      chatModels[0]?.id ||
      model;
    const modelEntries = Object.create(null);
    for (const m of chatModels.length
      ? chatModels
      : [{ id: chosenModel, name: chosenModel }]) {
      if (
        m.id === "__proto__" ||
        m.id === "constructor" ||
        m.id === "prototype"
      )
        continue;
      modelEntries[m.id] = {
        name: m.name || m.id,
        limit: { output: 8192 },
      };
    }

    const currentCfg = readJsonSafe(configPath);
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
      storeCredential("opencode", { token, apiBase, model: chosenModel }, { homeDir });
      const backup = backupOnce(configPath);
      backupOnce(authPath, { secret: true });
      writePrivateFile(configPath, cfgContent, 0o600);
      writePrivateFile(authPath, authContent, 0o600);
      return {
        agent,
        files: [configPath, authPath],
        backup,
        nextStep: "Run `opencode` in this terminal and send your first prompt.",
      };
    }
    return { agent, files: [configPath, authPath], preview: cfgContent };
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
      const backup = backupOnce(rcPath);
      const rcMode = fs.existsSync(rcPath)
        ? fs.statSync(rcPath).mode & 0o777 || 0o600
        : 0o600;
      writePrivateFile(rcPath, nextRc, rcMode);
      return {
        agent,
        files: [envPath, rcPath],
        backup,
        nextStep: `Run \`source ${shSingleQuote(envPath)} && copilot\` in this terminal (new terminals load it automatically).`,
      };
    }
    return { agent, files: [envPath, rcPath], preview: envContent };
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
  { homeDir = os.homedir(), shell = process.env.SHELL || "/bin/zsh" } = {},
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

  for (const a of targets) {
    removeCredential(a, { homeDir });
    if (a === "claude-code") {
      const fp = path.join(homeDir, ".claude", "settings.json");
      if (!restoreBak(fp, { secret: true }) && fs.existsSync(fp)) {
        const cur = readJsonSafe(fp);
        if (cur.env && typeof cur.env === "object") {
          delete cur.env.ANTHROPIC_BASE_URL;
          delete cur.env.ANTHROPIC_AUTH_TOKEN;
          delete cur.env.ANTHROPIC_MODEL;
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
    } else if (a === "copilot") {
      const envPath = path.join(hallpassDir(homeDir), "copilot.env");
      if (fs.existsSync(envPath)) {
        assertNotSymlink(envPath);
        fs.unlinkSync(envPath);
      }
      const rcPath = shell.includes("bash")
        ? path.join(homeDir, ".bashrc")
        : path.join(homeDir, ".zshrc");
      if (!restoreBak(rcPath) && fs.existsSync(rcPath)) {
        assertNotSymlink(rcPath);
        const raw = fs.readFileSync(rcPath, "utf8");
        const cleaned = raw.replace(
          new RegExp(`\\n?${SHELL_START}[\\s\\S]*?${SHELL_END}\\n?`, "g"),
          "\n",
        );
        const rcMode = fs.statSync(rcPath).mode & 0o777 || 0o600;
        writePrivateFile(rcPath, cleaned, rcMode);
        restored.push(rcPath);
      }
    }
  }
  return restored;
}
