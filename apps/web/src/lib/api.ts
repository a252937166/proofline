import type {
  CatalogMatchDetail,
  DecisionResponse,
  FeaturedProofSampleResponse,
  IntegrationsResponse,
  MatchCatalogResponse,
  McpRuntimeResponse,
  PaymentQuote,
  ProofPacketResponse,
  ProofVerificationResponse,
  ReplaySnapshot,
  TestUsdcClaimResponse,
  VerifyAnchorResponse,
} from "../types";

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "/api";
const SESSION_STORAGE_KEY = "proofline.replay-session.v1";
const RECOVERY_STORAGE_KEY = "proofline.settled-proof-session.v1";

function replaySessionId(): string {
  const valid = (value: string | null): value is string =>
    Boolean(value && /^web_[0-9a-f]{32}$/.test(value));
  const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
  const recovery = localStorage.getItem(RECOVERY_STORAGE_KEY);
  const reusable = valid(existing) ? existing : valid(recovery) ? recovery : null;
  if (reusable) {
    sessionStorage.setItem(SESSION_STORAGE_KEY, reusable);
    localStorage.setItem(RECOVERY_STORAGE_KEY, reusable);
    return reusable;
  }
  const created = `web_${crypto.randomUUID().replace(/-/g, "")}`;
  sessionStorage.setItem(SESSION_STORAGE_KEY, created);
  // This high-entropy ID can recover already-paid report content after a tab
  // or Chrome restart. It cannot authorize a transfer and no wallet signature,
  // nonce secret, or PAYMENT-SIGNATURE is persisted.
  localStorage.setItem(RECOVERY_STORAGE_KEY, created);
  return created;
}

// The x402 quote, ProofPurchase signature, and paid request must all use the
// same browser-scoped session. Export the value so the wallet can bind the
// second EIP-712 signature to the exact session sent on the wire.
export const PROOFLINE_SESSION_ID = replaySessionId();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    redirect: "error",
    headers: {
      Accept: "application/json",
      "X-Proofline-Session": PROOFLINE_SESSION_ID,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const detail =
      typeof body === "object" && body && "message" in body
        ? String((body as { message: unknown }).message)
        : `Request failed with HTTP ${response.status}.`;
    throw new ApiError(detail, response.status, body);
  }

  return body as T;
}

function decodePaymentRequirement(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;

  try {
    const decoded = atob(value.replace(/^Bearer\s+/i, ""));
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
}

function findDemoSignature(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const directKeys = [
    "demoPaymentSignature",
    "demoSignature",
    "paymentSignature",
    "sandboxSignature",
  ];

  for (const key of directKeys) {
    if (typeof record[key] === "string") return record[key];
  }

  for (const nested of Object.values(record)) {
    const found = findDemoSignature(nested);
    if (found) return found;
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isProofVerificationResponse(
  value: unknown,
): value is ProofVerificationResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<ProofVerificationResponse>;
  return (
    typeof report.valid === "boolean" &&
    typeof report.packetHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(report.packetHash) &&
    typeof report.recomputedPacketHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(report.recomputedPacketHash) &&
    typeof report.checkedAt === "string" &&
    Array.isArray(report.checks) &&
    Boolean(report.integrity) &&
    typeof report.integrity?.valid === "boolean" &&
    Boolean(report.signature) &&
    typeof report.signature?.valid === "boolean" &&
    Boolean(report.onchain) &&
    typeof report.onchain?.checked === "boolean" &&
    typeof report.onchain?.valid === "boolean" &&
    typeof report.onchain?.reason === "string"
  );
}

export const api = {
  getReplayState: (signal?: AbortSignal) => request<ReplaySnapshot>("/replay/state", { ...(signal ? { signal } : {}) }),

  resetReplay: (signal?: AbortSignal) => request<ReplaySnapshot>("/replay/reset", { method: "POST", ...(signal ? { signal } : {}) }),

  stepReplay: (signal?: AbortSignal) => request<ReplaySnapshot>("/replay/step", { method: "POST", ...(signal ? { signal } : {}) }),

  runReplay: (signal?: AbortSignal) => request<ReplaySnapshot>("/replay/run", { method: "POST", ...(signal ? { signal } : {}) }),

  pauseReplay: (signal?: AbortSignal) => request<ReplaySnapshot>("/replay/pause", { method: "POST", ...(signal ? { signal } : {}) }),

  getIntegrations: () => request<IntegrationsResponse>("/integrations"),

  claimTestUsdc: (recipient: string) =>
    request<TestUsdcClaimResponse>("/testnet-usdc/claims", {
      method: "POST",
      body: JSON.stringify({ recipient }),
    }),

  getMatchCatalog: () => request<MatchCatalogResponse>("/matches"),

  getCatalogMatch: (matchId: string) =>
    request<CatalogMatchDetail>(`/matches/${encodeURIComponent(matchId)}`),

  verifyMatchAnchor: (matchId: string, eventId = "final-result") =>
    request<VerifyAnchorResponse>(
      `/matches/${encodeURIComponent(matchId)}/verify-anchor?eventId=${encodeURIComponent(eventId)}`,
      { method: "POST" },
    ),

  getMcpRuntime: () => request<McpRuntimeResponse>("/mcp/runtime"),

  getFeaturedProofSample: () =>
    request<FeaturedProofSampleResponse>("/proofs/samples/featured"),

  getDecision: (matchId: string, eventId: string) =>
    request<DecisionResponse>(
      `/matches/${encodeURIComponent(matchId)}/decision?eventId=${encodeURIComponent(eventId)}`,
    ),

  async recoverSettledProof(
    matchId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<ProofPacketResponse | null> {
    const response = await fetch(`${API_BASE}/proofs/recover`, {
      method: "POST",
      redirect: "error",
      ...(signal ? { signal } : {}),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Proofline-Session": PROOFLINE_SESSION_ID,
      },
      body: JSON.stringify({ matchId, eventId }),
    });
    const parsed = (await response.json()) as unknown;
    const body = asRecord(parsed);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ApiError(
        typeof body?.message === "string"
          ? body.message
          : `Settled proof recovery failed with HTTP ${response.status}.`,
        response.status,
        parsed,
      );
    }
    return parsed as ProofPacketResponse;
  },

  async getProofQuote(matchId: string, eventId: string, signal?: AbortSignal): Promise<PaymentQuote | ProofPacketResponse> {
    const response = await fetch(
      `${API_BASE}/matches/${encodeURIComponent(matchId)}/proof?eventId=${encodeURIComponent(eventId)}`,
      {
        redirect: "error",
        ...(signal ? { signal } : {}),
        headers: {
          Accept: "application/json",
          "X-Proofline-Session": PROOFLINE_SESSION_ID,
        },
      },
    );
    const parsed = (await response.json()) as unknown;
    const body = asRecord(parsed);

    if (response.status === 402) {
      const paymentRequired = response.headers.get("PAYMENT-REQUIRED") ?? undefined;
      const decodedRequirement = decodePaymentRequirement(paymentRequired ?? null);
      const demoSignature = findDemoSignature(parsed);
      const quote: PaymentQuote = {
        status: 402,
        body: body ?? {},
      };
      if (paymentRequired) quote.paymentRequired = paymentRequired;
      if (decodedRequirement) quote.decodedRequirement = decodedRequirement;
      if (demoSignature) quote.demoSignature = demoSignature;
      return quote;
    }

    if (!response.ok) {
      throw new ApiError(
        typeof body?.message === "string" ? body.message : `Proof request failed with HTTP ${response.status}.`,
        response.status,
        parsed,
      );
    }

    return parsed as ProofPacketResponse;
  },

  submitProofPayment: (matchId: string, eventId: string, signature: string, signal?: AbortSignal) =>
    request<ProofPacketResponse>(
      `/matches/${encodeURIComponent(matchId)}/proof?eventId=${encodeURIComponent(eventId)}`,
      { headers: { "PAYMENT-SIGNATURE": signature }, ...(signal ? { signal } : {}) },
    ),

  async verifyProof(packet: ProofPacketResponse["packet"], signal?: AbortSignal) {
    const response = await fetch(`${API_BASE}/proofs/verify`, {
      method: "POST",
      redirect: "error",
      ...(signal ? { signal } : {}),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Proofline-Session": PROOFLINE_SESSION_ID,
      },
      body: JSON.stringify({ packet }),
    });
    const body = (await response.json()) as unknown;
    // A deterministic negative verification is still a complete report. The
    // UI must render its PASS/FAIL layers instead of replacing them with a
    // transport error and leaving every layer PENDING.
    if ((response.ok || response.status === 422) && isProofVerificationResponse(body)) {
      return body;
    }
    const detail = body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : `Proof verification failed with HTTP ${response.status}.`;
    throw new ApiError(
      detail,
      response.status,
      body,
    );
  },
};
