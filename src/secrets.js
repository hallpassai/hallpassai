import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const KNOWN_HARNESSES = [
  "claude-code",
  "codex",
  "opencode",
  "copilot",
  "cursor",
  "default",
  "all",
];

export function assertNotSymlink(targetPath) {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new Error(`Refusing to follow or overwrite symlink: ${targetPath}`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function restrictWindowsAcl(targetPath, isDir = false) {
  if (process.platform !== "win32") return;
  try {
    const icacls = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "icacls.exe",
    );
    const perm = isDir ? "(OI)(CI)F" : "(F)";
    const user = os.userInfo().username;
    spawnSync(
      icacls,
      [targetPath, "/inheritance:r", "/grant:r", `${user}:${perm}`],
      { stdio: "ignore", timeout: 4000 },
    );
  } catch {}
}

export function hallpassDir(homeDir = os.homedir()) {
  const xdg = process.env.HALLPASS_CONFIG_DIR;
  if (xdg && path.isAbsolute(xdg)) return path.resolve(xdg);
  return path.join(path.resolve(homeDir), ".config", "hallpass");
}

export function credentialsPath(homeDir = os.homedir()) {
  return path.join(hallpassDir(homeDir), "credentials.json");
}

export function helperScriptPath(homeDir = os.homedir()) {
  return path.join(hallpassDir(homeDir), "read-key.mjs");
}

export function telemetryPath(homeDir = os.homedir()) {
  return path.join(hallpassDir(homeDir), "telemetry.json");
}

export function telemetryDisabled(env = process.env) {
  return (
    env.DO_NOT_TRACK === "1" ||
    env.DO_NOT_TRACK === "true" ||
    env.HALLPASS_NO_TELEMETRY === "1" ||
    env.HALLPASS_TELEMETRY === "0"
  );
}

export function getAnonymousId(homeDir = os.homedir(), env = process.env) {
  if (telemetryDisabled(env)) return undefined;
  const fp = telemetryPath(homeDir);
  try {
    if (fs.existsSync(fp)) {
      assertNotSymlink(fp);
      const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (
        parsed &&
        typeof parsed.anonymousId === "string" &&
        /^hp_cli_[A-Za-z0-9_-]{8,64}$/.test(parsed.anonymousId)
      ) {
        return parsed.anonymousId;
      }
    }
    const anonymousId = `hp_cli_${crypto.randomUUID().replace(/-/g, "")}`;
    writePrivateFile(
      fp,
      JSON.stringify({ anonymousId, createdAt: new Date().toISOString() }, null, 2) + "\n",
      0o600,
    );
    return anonymousId;
  } catch {
    return undefined;
  }
}

export function ensurePrivateDir(dir) {
  assertNotSymlink(dir);
  const resolved = path.resolve(dir);
  const realHome = path.resolve(os.homedir());
  if (resolved === realHome || resolved === path.parse(resolved).root) {
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  restrictWindowsAcl(dir, true);
}

export function writePrivateFile(filePath, content, mode = 0o600) {
  assertNotSymlink(filePath);
  const parent = path.dirname(filePath);
  const baseName = path.basename(parent);
  const isHomeRoot =
    path.resolve(parent) === path.resolve(os.homedir()) ||
    (!baseName.startsWith(".") &&
      !parent.includes(`${path.sep}.`) &&
      path.basename(filePath).startsWith("."));
  if ((mode & 0o077) === 0 && !isHomeRoot) {
    ensurePrivateDir(parent);
  } else {
    assertNotSymlink(parent);
    fs.mkdirSync(parent, { recursive: true });
  }
  const nonce = crypto.randomBytes(8).toString("hex");
  const tmp = `${filePath}.tmp.${process.pid}.${nonce}`;
  const flags =
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_WRONLY |
    (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(tmp, flags, mode);
    try {
      fs.fchmodSync(fd, mode);
    } catch {}
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(fd, content);
    } else {
      fs.writeFileSync(fd, content, "utf8");
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if ((mode & 0o077) === 0) restrictWindowsAcl(tmp, false);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function readStoredCredentials(homeDir = os.homedir()) {
  const fp = credentialsPath(homeDir);
  if (!fs.existsSync(fp)) return { keys: {} };
  try {
    assertNotSymlink(fp);
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    return parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.keys &&
      typeof parsed.keys === "object"
      ? parsed
      : { keys: {} };
  } catch {
    return { keys: {} };
  }
}

export function storeCredential(
  harness,
  { token, apiBase, model, reasoning = null, mode = "default", paused = false },
  { homeDir = os.homedir(), useKeychain = process.platform === "darwin" } = {},
) {
  if (!/^[a-z0-9-]+$/.test(harness)) {
    throw new Error(`Invalid harness identifier: ${harness}`);
  }
  const dir = hallpassDir(homeDir);
  ensurePrivateDir(dir);

  let storedInKeychain = false;
  if (
    useKeychain &&
    process.env.HALLPASS_DISABLE_KEYCHAIN !== "1" &&
    homeDir === os.homedir()
  ) {
    // Pass hex-encoded secret via stdin (`security -i`) so raw tokens never appear in process argv (`ps aux`).
    const hexToken = Buffer.from(String(token), "utf8").toString("hex");
    const res = spawnSync("/usr/bin/security", ["-i"], {
      input: `add-generic-password -U -a ${harness} -s hallpassai -X ${hexToken}\n`,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5000,
    });
    storedInKeychain = res.status === 0;
  }

  const current = readStoredCredentials(homeDir);
  current.keys[harness] = {
    // Always keep 0600 file fallback so headless SSH / non-unlocked keychain sessions work seamlessly.
    token,
    keychain: storedInKeychain,
    apiBase,
    model,
    mode: mode === "coexist" ? "coexist" : "default",
    ...(paused ? { paused: true } : {}),
    ...(reasoning && reasoning !== "auto" ? { reasoning } : {}),
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
  const fp = credentialsPath(homeDir);
  const current = fs.existsSync(fp)
    ? readStoredCredentials(homeDir)
    : { keys: {} };
  const targets =
    harness === "all"
      ? Array.from(
          new Set([...KNOWN_HARNESSES, ...Object.keys(current.keys || {})]),
        )
      : [harness];

  if (
    useKeychain &&
    process.env.HALLPASS_DISABLE_KEYCHAIN !== "1" &&
    homeDir === os.homedir()
  ) {
    for (const acct of targets) {
      if (!/^[a-z0-9-]+$/.test(acct)) continue;
      spawnSync(
        "/usr/bin/security",
        ["delete-generic-password", "-a", acct, "-s", "hallpassai"],
        { stdio: "ignore", timeout: 4000 },
      );
    }
  }
  if (!fs.existsSync(fp)) return;
  if (harness === "all") current.keys = {};
  else delete current.keys[harness];
  writePrivateFile(fp, JSON.stringify(current, null, 2) + "\n", 0o600);
}

export function purgeHallpassDir(
  homeDir = os.homedir(),
  { useKeychain = process.platform === "darwin" } = {},
) {
  const removed = [];
  removeCredential("all", { homeDir, useKeychain });
  const dir = hallpassDir(homeDir);
  for (const fileName of [
    "copilot.env",
    "copilot.fish",
    "claude-settings.json",
    "previous-state.json",
    "read-key.mjs",
    "credentials.json",
    "telemetry.json",
  ]) {
    const fp = path.join(dir, fileName);
    if (fs.existsSync(fp)) {
      assertNotSymlink(fp);
      fs.unlinkSync(fp);
      removed.push(fp);
    }
  }
  const shimsDir = path.join(dir, "bin");
  if (fs.existsSync(shimsDir)) {
    assertNotSymlink(shimsDir);
    for (const shimName of ["claude-hp", "codex-hp", "copilot-hp"]) {
      const sp = path.join(shimsDir, shimName);
      if (fs.existsSync(sp)) {
        assertNotSymlink(sp);
        fs.unlinkSync(sp);
        removed.push(sp);
      }
    }
    try {
      if (fs.readdirSync(shimsDir).length === 0) fs.rmdirSync(shimsDir);
    } catch {}
  }
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {}
  return removed;
}

export function ensureHelperScript(homeDir = os.homedir()) {
  const script = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const harness = process.argv[2] || "default";
if (!/^[a-z0-9-]+$/.test(harness)) process.exit(1);

if (process.platform === "darwin" && process.env.HALLPASS_DISABLE_KEYCHAIN !== "1") {
  const kc = spawnSync("/usr/bin/security", ["find-generic-password", "-a", harness, "-s", "hallpassai", "-w"], {
    encoding: "utf8",
    timeout: 2500,
  });
  if (kc.status === 0 && kc.stdout.trim()) {
    process.stdout.write(kc.stdout.trim());
    process.exit(0);
  }
}
const credPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "credentials.json");
const data = JSON.parse(fs.readFileSync(credPath, "utf8"));
const keys = data && typeof data.keys === "object" ? data.keys : {};
const entry = Object.hasOwn(keys, harness)
  ? keys[harness]
  : Object.hasOwn(keys, "all")
    ? keys.all
    : null;
if (!entry?.token) process.exit(1);
process.stdout.write(entry.token);
`;
  const target = helperScriptPath(homeDir);
  writePrivateFile(target, script, 0o700);
  return target;
}
