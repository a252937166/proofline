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
  VerifyAnchorResponse,
} from "../types";

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "/api";
const SESSION_STORAGE_KEY = "proofline.replay-session.v1";

function replaySessionId(): string {
  const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  const created = `web_${crypto.randomUUID().replace(/-/g, "")}`;
  sessionStorage.setItem(SESSION_STORAGE_KEY, created);
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

export const api = {
  getReplayState: (signal?: AbortSignal) => request<ReplaySnapshot>("/replay/state", { ...(signal ? { signal } : {}) }),

  resetReplay: (signal?: AbortSignal) => request<ReplaySnapshot>("/replay/reset", { method: "POST", ...(signal ? { signal } : {}) }),

  stepReplay: (signal?: AbortSignal) => request<ReplaySnapshot>("/replay/step", { method: "POST", ...(signal ? { signal } : {}) }),

  runReplay: (signal?: AbortSignal) => request<ReplaySnapshot>("/replay/run", { method: "POST", ...(signal ? { signal } : {}) }),

  pauseReplay: (signal?: AbortSignal) => request<ReplaySnapshot>("/replay/pause", { method: "POST", ...(signal ? { signal } : {}) }),

  getIntegrations: () => request<IntegrationsResponse>("/integrations"),

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
    const body = (await response.json()) as Record<string, unknown>;

    if (response.status === 402) {
      const paymentRequired = response.headers.get("PAYMENT-REQUIRED") ?? undefined;
      const decodedRequirement = decodePaymentRequirement(paymentRequired ?? null);
      const demoSignature = findDemoSignature(body);
      const quote: PaymentQuote = {
        status: 402,
        body,
      };
      if (paymentRequired) quote.paymentRequired = paymentRequired;
      if (decodedRequirement) quote.decodedRequirement = decodedRequirement;
      if (demoSignature) quote.demoSignature = demoSignature;
      return quote;
    }

    if (!response.ok) {
      throw new ApiError(
        typeof body.message === "string" ? body.message : `Proof request failed with HTTP ${response.status}.`,
        response.status,
        body,
      );
    }

    return body as unknown as ProofPacketResponse;
  },

  submitProofPayment: (matchId: string, eventId: string, signature: string, signal?: AbortSignal) =>
    request<ProofPacketResponse>(
      `/matches/${encodeURIComponent(matchId)}/proof?eventId=${encodeURIComponent(eventId)}`,
      { headers: { "PAYMENT-SIGNATURE": signature }, ...(signal ? { signal } : {}) },
    ),

  verifyProof: (packet: ProofPacketResponse["packet"], signal?: AbortSignal) =>
    request<ProofVerificationResponse>("/proofs/verify", {
      method: "POST",
      ...(signal ? { signal } : {}),
      body: JSON.stringify({ packet }),
    }),
};
