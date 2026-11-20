import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export function hallpassDir(homeDir = os.homedir()) {
  const xdg = process.env.HALLPASS_CONFIG_DIR;
  if (xdg) return xdg;
  return path.join(homeDir, ".config", "hallpass");
}

export function credentialsPath(homeDir = os.homedir()) {
  return path.join(hallpassDir(homeDir), "credentials.json");
}

export function helperScriptPath(homeDir = os.homedir()) {
  return path.join(hallpassDir(homeDir), "read-key.mjs");
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

export function writePrivateFile(filePath, content, mode = 0o600) {
  ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch {}
  fs.renameSync(tmp, filePath);
}

export function readStoredCredentials(homeDir = os.homedir()) {
  const fp = credentialsPath(homeDir);
  if (!fs.existsSync(fp)) return { keys: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    return parsed && typeof parsed === "object" && parsed.keys
      ? parsed
      : { keys: {} };
  } catch {
    return { keys: {} };
  }
}

export function storeCredential(
  harness,
  { token, apiBase, model },
  { homeDir = os.homedir(), useKeychain = process.platform === "darwin" } = {},
) {
  const dir = hallpassDir(homeDir);
  ensurePrivateDir(dir);

  let storedInKeychain = false;
  if (
    useKeychain &&
    process.env.HALLPASS_DISABLE_KEYCHAIN !== "1" &&
    homeDir === os.homedir()
  ) {
    const res = spawnSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-a",
        harness,
        "-s",
        "hallpassai",
        "-w",
        token,
      ],
      { stdio: "ignore" },
    );
    storedInKeychain = res.status === 0;
  }

  const current = readStoredCredentials(homeDir);
  current.keys[harness] = {
    // Always keep 0600 file fallback so headless SSH / non-unlocked keychain sessions work seamlessly.
    token,
    keychain: storedInKeychain,
    apiBase,
    model,
    updatedAt: new Date().toISOString(),
  };
  writePrivateFile(
    credentialsPath(homeDir),
    JSON.stringify(current, null, 2) + "\n",
    0o600,
  );
  ensureHelperScript(homeDir);
  return { storedInKeychain, credentialsFile: credentialsPath(homeDir) };
}

export function removeCredential(
  harness,
  { homeDir = os.homedir(), useKeychain = process.platform === "darwin" } = {},
) {
  if (
    useKeychain &&
    process.env.HALLPASS_DISABLE_KEYCHAIN !== "1" &&
    homeDir === os.homedir()
  ) {
    spawnSync(
      "security",
      ["delete-generic-password", "-a", harness, "-s", "hallpassai"],
      { stdio: "ignore" },
    );
  }
  const fp = credentialsPath(homeDir);
  if (!fs.existsSync(fp)) return;
  const current = readStoredCredentials(homeDir);
  if (harness === "all") current.keys = {};
  else delete current.keys[harness];
  writePrivateFile(fp, JSON.stringify(current, null, 2) + "\n", 0o600);
}

export function ensureHelperScript(homeDir = os.homedir()) {
  const script = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const harness = process.argv[2] || "default";
if (process.platform === "darwin" && process.env.HALLPASS_DISABLE_KEYCHAIN !== "1") {
  const kc = spawnSync("security", ["find-generic-password", "-a", harness, "-s", "hallpassai", "-w"], { encoding: "utf8" });
  if (kc.status === 0 && kc.stdout.trim()) {
    process.stdout.write(kc.stdout.trim());
    process.exit(0);
  }
}
const credPath = path.join(path.dirname(new URL(import.meta.url).pathname), "credentials.json");
const data = JSON.parse(fs.readFileSync(credPath, "utf8"));
const entry = data?.keys?.[harness] || data?.keys?.all || Object.values(data?.keys || {})[0];
if (!entry?.token) process.exit(1);
process.stdout.write(entry.token);
`;
  writePrivateFile(helperScriptPath(homeDir), script, 0o700);
  return helperScriptPath(homeDir);
}
