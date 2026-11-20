import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
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

function backupOnce(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const bak = `${filePath}.hallpass.bak`;
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(filePath, bak);
    try {
      const mode = fs.statSync(filePath).mode & 0o777;
      fs.chmodSync(bak, mode);
    } catch {}
  }
  return bak;
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function resolveOpencodeDirs(homeDir, env = process.env) {
  const useEnvXdg = homeDir === os.homedir();
  const configDir = useEnvXdg && env.XDG_CONFIG_HOME
    ? path.join(env.XDG_CONFIG_HOME, "opencode")
    : path.join(homeDir, ".config", "opencode");
  const dataDir = useEnvXdg && env.XDG_DATA_HOME
    ? path.join(env.XDG_DATA_HOME, "opencode")
    : path.join(homeDir, ".local", "share", "opencode");
  return { configDir, dataDir };
}

export function detectInstalledAgents(homeDir = os.homedir(), env = process.env) {
  const found = [];
  const hasCmd = (cmd) => {
    const res = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
      env,
    });
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

export function upsertCodexToml(
  existingToml,
  { model, apiBase, nodePath, helperPath },
) {
  const lines = existingToml ? existingToml.replace(/\r\n/g, "\n").split("\n") : [];
  // Strip any previous [model_providers.hallpass] and [model_providers.hallpass.*] sections.
  const kept = [];
  let skippingHallpass = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      const name = section[1].trim();
      skippingHallpass =
        name === "model_providers.hallpass" ||
        name.startsWith("model_providers.hallpass.");
    }
    if (!skippingHallpass) kept.push(line);
  }

  // Update or insert top-level `model` and `model_provider` BEFORE the first `[section]`.
  const firstSectionIdx = kept.findIndex((l) => /^\s*\[[^\]]+\]/.test(l));
  const limit = firstSectionIdx === -1 ? kept.length : firstSectionIdx;
  let sawModel = false;
  let sawProvider = false;
  for (let i = 0; i < limit; i++) {
    if (/^\s*model\s*=/.test(kept[i])) {
      kept[i] = `model = ${JSON.stringify(model)}`;
      sawModel = true;
    } else if (/^\s*model_provider\s*=/.test(kept[i])) {
      kept[i] = `model_provider = "hallpass"`;
      sawProvider = true;
    }
  }
  const topInserts = [];
  if (!sawModel) topInserts.push(`model = ${JSON.stringify(model)}`);
  if (!sawProvider) topInserts.push(`model_provider = "hallpass"`);
  if (topInserts.length) {
    kept.splice(0, 0, ...topInserts, ...(kept.length && kept[0] !== "" ? [""] : []));
  }

  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const block = [
    ...(kept.length ? [""] : []),
    "[model_providers.hallpass]",
    `name = "HallPass"`,
    `base_url = ${JSON.stringify(apiBase)}`,
    `wire_api = "responses"`,
    "",
    "[model_providers.hallpass.auth]",
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(helperPath)}, "codex"]`,
    `timeout_ms = 3000`,
    "",
  ];
  return [...kept, ...block].join("\n");
}

const SHELL_START = "# >>> hallpass >>>";
const SHELL_END = "# <<< hallpass <<<";

export function upsertShellBlock(existingContent, envFilePath, isFish = false) {
  const stripped = (existingContent || "")
    .replace(
      new RegExp(
        `\\n?${SHELL_START}[\\s\\S]*?${SHELL_END}\\n?`,
        "g",
      ),
      "\n",
    )
    .trimEnd();
  const sourceLine = isFish
    ? `test -f ${JSON.stringify(envFilePath)}; and bass source ${JSON.stringify(envFilePath)} 2>/dev/null`
    : `[ -f ${JSON.stringify(envFilePath)} ] && . ${JSON.stringify(envFilePath)}`;
  const block = `${SHELL_START}\n${sourceLine}\n${SHELL_END}\n`;
  return stripped ? `${stripped}\n\n${block}` : block;
}

export function copyToClipboard(text) {
  const cmds =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  for (const [cmd, args] of cmds) {
    const res = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
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
  const anthropicBase = apiBase.replace(/\/v1\/?$/, "");

  if (agent === "claude-code") {
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const current = readJsonSafe(settingsPath);
    const next = {
      ...current,
      env: {
        ...(current.env && typeof current.env === "object" ? current.env : {}),
        ANTHROPIC_BASE_URL: anthropicBase,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: model,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      },
    };
    const content = JSON.stringify(next, null, 2) + "\n";
    if (!dryRun) {
      storeCredential("claude-code", { token, apiBase, model }, { homeDir });
      const backup = backupOnce(settingsPath);
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
      const backup = backupOnce(configPath);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, content, "utf8");
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
    const modelEntries = {};
    for (const m of chatModels.length ? chatModels : [{ id: chosenModel, name: chosenModel }]) {
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
        key: token,
      },
    };
    const authContent = JSON.stringify(nextAuth, null, 2) + "\n";

    if (!dryRun) {
      storeCredential("opencode", { token, apiBase, model: chosenModel }, { homeDir });
      const backup = backupOnce(configPath);
      backupOnce(authPath);
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, cfgContent, "utf8");
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
      `export COPILOT_OFFLINE="true"`,
      `export COPILOT_PROVIDER_TYPE="openai"`,
      `export COPILOT_PROVIDER_BASE_URL=${JSON.stringify(apiBase)}`,
      `export COPILOT_PROVIDER_API_KEY=${JSON.stringify(token)}`,
      `export COPILOT_MODEL=${JSON.stringify(chosenModel)}`,
      "",
    ].join("\n");

    const rcPath = shell.includes("bash")
      ? path.join(homeDir, ".bashrc")
      : path.join(homeDir, ".zshrc");
    const existingRc = fs.existsSync(rcPath)
      ? fs.readFileSync(rcPath, "utf8")
      : "";
    const nextRc = upsertShellBlock(existingRc, envPath, false);

    if (!dryRun) {
      storeCredential("copilot", { token, apiBase, model: chosenModel }, { homeDir });
      writePrivateFile(envPath, envContent, 0o600);
      const backup = backupOnce(rcPath);
      fs.writeFileSync(rcPath, nextRc, "utf8");
      return {
        agent,
        files: [envPath, rcPath],
        backup,
        nextStep: `Run \`source ${envPath} && copilot\` in this terminal (new terminals load it automatically).`,
      };
    }
    return { agent, files: [envPath, rcPath], preview: envContent.replace(token, "hp_live_••••••••") };
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
        apiKey: token,
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
  const targets =
    agent === "all" ? SUPPORTED_AGENTS : [agent];
  const restored = [];

  const restoreBak = (fp) => {
    const bak = `${fp}.hallpass.bak`;
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, fp);
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
      if (!restoreBak(fp) && fs.existsSync(fp)) {
        const cur = readJsonSafe(fp);
        if (cur.env) {
          delete cur.env.ANTHROPIC_BASE_URL;
          delete cur.env.ANTHROPIC_AUTH_TOKEN;
          delete cur.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
          delete cur.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
          fs.writeFileSync(fp, JSON.stringify(cur, null, 2) + "\n", "utf8");
          restored.push(fp);
        }
      }
    } else if (a === "codex") {
      const fp = path.join(homeDir, ".codex", "config.toml");
      restoreBak(fp);
    } else if (a === "opencode") {
      const { configDir: cfgDir, dataDir } = resolveOpencodeDirs(homeDir);
      restoreBak(path.join(cfgDir, "opencode.json"));
      restoreBak(path.join(dataDir, "auth.json"));
    } else if (a === "copilot") {
      const envPath = path.join(hallpassDir(homeDir), "copilot.env");
      if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
      const rcPath = shell.includes("bash")
        ? path.join(homeDir, ".bashrc")
        : path.join(homeDir, ".zshrc");
      if (!restoreBak(rcPath) && fs.existsSync(rcPath)) {
        const raw = fs.readFileSync(rcPath, "utf8");
        const cleaned = raw.replace(
          new RegExp(`\\n?${SHELL_START}[\\s\\S]*?${SHELL_END}\\n?`, "g"),
          "\n",
        );
        fs.writeFileSync(rcPath, cleaned, "utf8");
        restored.push(rcPath);
      }
    }
  }
  return restored;
}
