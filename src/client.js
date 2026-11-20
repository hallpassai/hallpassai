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
  if (explicitOrigin) return explicitOrigin.replace(/\/+$/, "");
  if (process.env.HALLPASS_ORIGIN)
    return process.env.HALLPASS_ORIGIN.replace(/\/+$/, "");
  if (prefix === "HPD") return "https://dev.hallpassai.com";
  if (prefix === "HPL") return "http://127.0.0.1:4317";
  return "https://app.hallpassai.com";
}

export async function claimCode(code, { origin, fetcher = fetch } = {}) {
  const parsed = normalizeCode(code);
  if (!parsed) {
    const err = new Error(
      "Invalid pairing code. Expected format like HP-XXXX-XXXX.",
    );
    err.code = "invalid_pairing_code";
    throw err;
  }
  const baseOrigin = resolveOrigin(parsed.prefix, origin);
  const res = await fetcher(`${baseOrigin}/api/core/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: parsed.code }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const codeName = body?.error?.code || "claim_failed";
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
    };
    const err = new Error(
      messages[codeName] || `Pairing failed (${codeName}).`,
    );
    err.code = codeName;
    throw err;
  }
  return { ...body, resolvedOrigin: baseOrigin };
}

export async function verifyGatewayReachable(
  { apiBase, token },
  { fetcher = fetch } = {},
) {
  try {
    const res = await fetcher(`${apiBase.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendPairingStatus(
  { origin, progressToken, phase, errorCode },
  { fetcher = fetch } = {},
) {
  if (!origin || !progressToken) return;
  try {
    await fetcher(`${origin.replace(/\/+$/, "")}/api/core/pair/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progressToken, phase, errorCode }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {}
}
