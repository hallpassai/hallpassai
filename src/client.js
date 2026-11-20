const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const VALID_HARNESSES = new Set([
  "claude-code",
  "codex",
  "opencode",
  "copilot",
  "cursor",
  "all",
]);

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || "").toLowerCase());
}

function hasDisallowedUrlChars(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function stripTerminalControls(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0x20 && code < 0x7f) || code >= 0xa0) out += str[i];
  }
  return out;
}

export function validateEndpointUrl(
  raw,
  { requireRootPath = false, allowHttpLoopback = true } = {},
) {
  if (typeof raw !== "string" || !raw.trim() || hasDisallowedUrlChars(raw)) {
    throw new Error("Invalid endpoint URL.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid endpoint URL.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "Endpoint URL must not include credentials, query parameters, or fragments.",
    );
  }
  const isHttps = parsed.protocol === "https:";
  const isLoopbackHttp =
    allowHttpLoopback &&
    parsed.protocol === "http:" &&
    isLoopbackHost(parsed.hostname);
  if (!isHttps && !isLoopbackHttp) {
    throw new Error(
      "Insecure origin: HTTPS is required (HTTP is only allowed for 127.0.0.1/localhost).",
    );
  }
  if (requireRootPath && parsed.pathname !== "/") {
    throw new Error("Origin URL must not include a path.");
  }
  if (/\/\.\.(\/|$)/.test(parsed.pathname)) {
    throw new Error("Invalid path segments in endpoint URL.");
  }
  return requireRootPath
    ? parsed.origin
    : `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function registrableTail(hostname) {
  const parts = hostname.toLowerCase().split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : hostname.toLowerCase();
}

function assertApiBaseMatchesOrigin(apiBaseUrl, resolvedOriginUrl) {
  const api = new URL(apiBaseUrl);
  const orig = new URL(resolvedOriginUrl);
  if (isLoopbackHost(orig.hostname)) {
    if (!isLoopbackHost(api.hostname)) {
      throw new Error("Loopback origin cannot configure a non-loopback apiBase.");
    }
    return;
  }
  if (api.protocol !== "https:") {
    throw new Error("Non-loopback apiBase must use HTTPS.");
  }
  if (
    api.hostname.toLowerCase() !== orig.hostname.toLowerCase() &&
    registrableTail(api.hostname) !== registrableTail(orig.hostname)
  ) {
    throw new Error(
      `Untrusted apiBase host "${api.hostname}" for origin "${orig.hostname}".`,
    );
  }
}

export function normalizeCode(raw) {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const compact = raw.trim().toUpperCase().replace(/[\s_-]+/g, "");
  const m = compact.match(/^(HPL|HPD|HP)([A-HJ-NP-Z2-9]{8})$/);
  if (!m) return null;
  return {
    prefix: m[1],
    code: `${m[1]}-${m[2].slice(0, 4)}-${m[2].slice(4, 8)}`,
  };
}

export function resolveOrigin(prefix, explicitOrigin) {
  const custom = explicitOrigin || process.env.HALLPASS_ORIGIN;
  if (custom) {
    const normalized = validateEndpointUrl(custom, { requireRootPath: true });
    if (
      prefix &&
      prefix !== "HPL" &&
      !explicitOrigin &&
      isLoopbackHost(new URL(normalized).hostname)
    ) {
      throw new Error(
        "Refusing to send non-local pairing code to loopback HALLPASS_ORIGIN without --origin.",
      );
    }
    return normalized;
  }
  if (prefix === "HPD") return "https://dev.hallpassai.com";
  if (prefix === "HPL") return "http://127.0.0.1:4317";
  return "https://app.hallpassai.com";
}

export function validateClaimPayload(body, resolvedOrigin) {
  if (!body || typeof body !== "object") {
    throw new Error("Malformed pairing response.");
  }
  const apiBase = validateEndpointUrl(body.apiBase);
  assertApiBaseMatchesOrigin(apiBase, resolvedOrigin);

  if (
    typeof body.token !== "string" ||
    !/^[A-Za-z0-9_.-]{16,256}$/.test(body.token)
  ) {
    throw new Error("Invalid API token format in pairing response.");
  }
  if (typeof body.harness !== "string" || !VALID_HARNESSES.has(body.harness)) {
    throw new Error("Invalid harness in pairing response.");
  }
  if (
    typeof body.model !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,128}$/.test(body.model)
  ) {
    throw new Error("Invalid model identifier in pairing response.");
  }
  const progressToken =
    typeof body.progressToken === "string" &&
    /^hp_pair_[A-Za-z0-9_-]{16,128}$/.test(body.progressToken)
      ? body.progressToken
      : null;
  const models = Array.isArray(body.models)
    ? body.models
        .filter(
          (m) =>
            m &&
            typeof m.id === "string" &&
            /^[A-Za-z0-9._:/-]{1,128}$/.test(m.id) &&
            m.id !== "__proto__" &&
            m.id !== "constructor" &&
            m.id !== "prototype",
        )
        .map((m) => ({
          id: m.id,
          name:
            typeof m.name === "string"
              ? stripTerminalControls(m.name).slice(0, 128)
              : m.id,
          protocols: Array.isArray(m.protocols)
            ? m.protocols.filter((p) => typeof p === "string")
            : [],
        }))
    : [];
  return {
    operationId:
      typeof body.operationId === "string" ? body.operationId : undefined,
    harness: body.harness,
    model: body.model,
    token: body.token,
    progressToken,
    apiBase,
    models,
    resolvedOrigin,
  };
}

export function originFromApiBase(apiBase, explicitOrigin = null) {
  if (explicitOrigin) {
    return validateEndpointUrl(explicitOrigin, { requireRootPath: true });
  }
  const safeBase = validateEndpointUrl(apiBase);
  const u = new URL(safeBase);
  if (u.hostname.toLowerCase() === "api.hallpassai.com") {
    return "https://app.hallpassai.com";
  }
  return u.origin;
}

export function buildCliMeta({
  cliVersion,
  anonymousId,
  targetHarness,
  modelId,
  configuredHarnesses,
  gatewayVerified,
  healthy,
} = {}) {
  const meta = {
    platform: process.platform,
    arch: process.arch,
  };
  if (typeof cliVersion === "string" && cliVersion) meta.cliVersion = cliVersion;
  if (typeof anonymousId === "string" && anonymousId)
    meta.anonymousId = anonymousId;
  if (typeof targetHarness === "string" && targetHarness)
    meta.targetHarness = targetHarness;
  if (typeof modelId === "string" && modelId) meta.modelId = modelId;
  if (Array.isArray(configuredHarnesses) && configuredHarnesses.length)
    meta.configuredHarnesses = configuredHarnesses;
  if (typeof gatewayVerified === "boolean")
    meta.gatewayVerified = gatewayVerified;
  if (typeof healthy === "boolean") meta.healthy = healthy;
  return meta;
}

export async function claimCode(
  code,
  { origin, meta = null, fetcher = fetch } = {},
) {
  const parsed = normalizeCode(code);
  if (!parsed) {
    const err = new Error(
      "Invalid pairing code. Expected format like HP-XXXX-XXXX.",
    );
    err.code = "invalid_pairing_code";
    throw err;
  }
  const baseOrigin = resolveOrigin(parsed.prefix, origin);
  const ua = meta?.cliVersion
    ? `hallpassai/${meta.cliVersion} (${process.platform}; ${process.arch})`
    : `hallpassai (${process.platform}; ${process.arch})`;
  const res = await fetcher(`${baseOrigin}/api/core/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": ua },
    body: JSON.stringify({ code: parsed.code, ...(meta ? { meta } : {}) }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawCode =
      typeof body?.error?.code === "string" ? body.error.code : "claim_failed";
    const codeName = rawCode.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64) || "claim_failed";
    const messages = {
      invalid_pairing_code:
        "Pairing code not recognized. Copy a fresh code from HallPass Connect.",
      pairing_expired:
        "This pairing code expired (codes last 10 minutes). Generate a fresh one on HallPass Connect.",
      pairing_already_used:
        "This pairing code was already used. Generate a fresh code if you need to re-pair.",
      account_restricted:
        "Your HallPass account is currently paused. Visit HallPass for details.",
      key_limit:
        "You’ve reached the 10 active API key limit. Revoke an unused key in HallPass first.",
      rate_limited:
        "Too many pairing attempts. Wait a minute and try again.",
    };
    const err = new Error(
      messages[codeName] || `Pairing failed (${codeName}).`,
    );
    err.code = codeName;
    throw err;
  }
  return validateClaimPayload(body, baseOrigin);
}

export async function fetchLiveModels(
  { apiBase, token },
  { fetcher = fetch } = {},
) {
  const t0 = Date.now();
  try {
    const safeBase = validateEndpointUrl(apiBase);
    if (
      typeof token !== "string" ||
      !/^[A-Za-z0-9_.-]{16,256}$/.test(token)
    ) {
      return { ok: false, latencyMs: Date.now() - t0, models: [] };
    }
    const res = await fetcher(`${safeBase}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!res.ok) return { ok: false, latencyMs: Date.now() - t0, models: [] };
    const body = await res.json().catch(() => ({}));
    const models = Array.isArray(body?.data)
      ? body.data
          .filter(
            (m) =>
              m &&
              typeof m.id === "string" &&
              /^[A-Za-z0-9._:/-]{1,128}$/.test(m.id),
          )
          .map((m) => m.id)
      : [];
    return { ok: true, latencyMs: Date.now() - t0, models };
  } catch {
    return { ok: false, latencyMs: Date.now() - t0, models: [] };
  }
}

export async function verifyGatewayReachable(
  { apiBase, token },
  { fetcher = fetch } = {},
) {
  const res = await fetchLiveModels({ apiBase, token }, { fetcher });
  return res.ok;
}

export async function sendPairingStatus(
  { origin, progressToken, phase, errorCode, meta = null },
  { fetcher = fetch } = {},
) {
  if (!origin || !progressToken) return;
  try {
    const safeOrigin = validateEndpointUrl(origin, { requireRootPath: true });
    await fetcher(`${safeOrigin}/api/core/pair/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        progressToken,
        phase,
        errorCode,
        ...(meta ? { meta } : {}),
      }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
  } catch {}
}

export async function revokeServerToken(
  { origin, apiBase, token, meta = null },
  { fetcher = fetch } = {},
) {
  if (typeof token !== "string" || !/^hp_live_[A-Za-z0-9_-]{43}$/.test(token)) {
    return false;
  }
  try {
    const safeOrigin = originFromApiBase(apiBase, origin);
    const res = await fetcher(`${safeOrigin}/api/core/cli/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(meta ? { meta } : {}),
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return Boolean(body?.revoked);
  } catch {
    return false;
  }
}

export async function sendCliEvent(
  name,
  { origin, apiBase, token, meta = null } = {},
  { fetcher = fetch } = {},
) {
  try {
    const safeOrigin = origin
      ? validateEndpointUrl(origin, { requireRootPath: true })
      : apiBase
        ? originFromApiBase(apiBase)
        : "https://app.hallpassai.com";
    const headers = { "Content-Type": "application/json" };
    if (
      typeof token === "string" &&
      /^hp_live_[A-Za-z0-9_-]{43}$/.test(token)
    ) {
      headers.Authorization = `Bearer ${token}`;
    }
    await fetcher(`${safeOrigin}/api/core/cli/event`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, ...(meta ? { meta } : {}) }),
      signal: AbortSignal.timeout(2500),
      redirect: "error",
    });
  } catch {}
}
