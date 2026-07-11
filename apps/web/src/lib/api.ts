import type {
  DecisionResponse,
  IntegrationsResponse,
  PaymentQuote,
  ProofPacketResponse,
  ProofVerificationResponse,
  ReplaySnapshot,
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

const REPLAY_SESSION_ID = replaySessionId();

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
      "X-Proofline-Session": REPLAY_SESSION_ID,
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
  getReplayState: () => request<ReplaySnapshot>("/replay/state"),

  resetReplay: () => request<ReplaySnapshot>("/replay/reset", { method: "POST" }),

  stepReplay: () => request<ReplaySnapshot>("/replay/step", { method: "POST" }),

  runReplay: () => request<ReplaySnapshot>("/replay/run", { method: "POST" }),

  pauseReplay: () => request<ReplaySnapshot>("/replay/pause", { method: "POST" }),

  getIntegrations: () => request<IntegrationsResponse>("/integrations"),

  getDecision: (matchId: string, eventId: string) =>
    request<DecisionResponse>(
      `/matches/${encodeURIComponent(matchId)}/decision?eventId=${encodeURIComponent(eventId)}`,
    ),

  async getProofQuote(matchId: string, eventId: string): Promise<PaymentQuote | ProofPacketResponse> {
    const response = await fetch(
      `${API_BASE}/matches/${encodeURIComponent(matchId)}/proof?eventId=${encodeURIComponent(eventId)}`,
      {
        redirect: "error",
        headers: {
          Accept: "application/json",
          "X-Proofline-Session": REPLAY_SESSION_ID,
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

  submitProofPayment: (matchId: string, eventId: string, signature: string) =>
    request<ProofPacketResponse>(
      `/matches/${encodeURIComponent(matchId)}/proof?eventId=${encodeURIComponent(eventId)}`,
      { headers: { "PAYMENT-SIGNATURE": signature } },
    ),

  verifyProof: (packet: ProofPacketResponse["packet"]) =>
    request<ProofVerificationResponse>("/proofs/verify", {
      method: "POST",
      body: JSON.stringify({ packet }),
    }),
};
