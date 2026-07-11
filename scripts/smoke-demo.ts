import "dotenv/config";

const base = (
  process.env.PROOFLINE_API_BASE ?? "http://127.0.0.1:8787/api"
).replace(/\/$/, "");
const matchId = "WC-2022-WAL-IRN";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type ReplayState = {
  replay: { cursor: number; totalFrames: number };
  events: Array<{
    eventId: string;
    verification: { state: string; conflicts: unknown[] };
  }>;
};

await json<ReplayState>("/replay/reset", { method: "POST" });
let state: ReplayState | undefined;
for (let index = 0; index < 4; index += 1) {
  state = await json<ReplayState>("/replay/step", { method: "POST" });
}

const redCard = state?.events.find(
  (event) => event.eventId === "hennessey-red-86",
);
assert(redCard?.verification.state === "contested", "Frame 4 must quarantine the red/yellow conflict");
assert(redCard.verification.conflicts.length === 1, "Frame 4 must expose one active material conflict");

for (let index = 4; index < 15; index += 1) {
  state = await json<ReplayState>("/replay/step", { method: "POST" });
}
assert(state, "Replay returned no final state");
assert(state.replay.cursor === state.replay.totalFrames, "Replay did not complete");

const decision = await json<{
  verification: { state: string; confidenceBps: number };
  anchor: { simulated: boolean; receipt: { confirmed: boolean; mode: string } };
  decision: { allowed: boolean };
}>(`/matches/${matchId}/decision?eventId=final-result`);
assert(decision.verification.state === "verified", "Final result was not verified");
assert(decision.anchor.receipt.confirmed, "Final result was not anchored");
assert(decision.decision.allowed, "Settlement gate did not open");

const proofPath = `/matches/${matchId}/proof?eventId=final-result`;
const quoteResponse = await fetch(`${base}${proofPath}`, {
  headers: { accept: "application/json" },
});
const quote = (await quoteResponse.json()) as {
  mode?: string;
  demoSandbox?: { paymentSignature?: string };
};
assert(quoteResponse.status === 402, "Paid proof did not negotiate with HTTP 402");
assert(quote.mode === "demo-sandbox", "Smoke test only accepts the labelled sandbox quote");
assert(quote.demoSandbox?.paymentSignature, "Sandbox quote omitted its deterministic retry token");

const paid = await json<{
  packet: { packetHash: string };
  payment: { simulated: boolean; valueTransferred: boolean };
}>(proofPath, {
  headers: { "PAYMENT-SIGNATURE": quote.demoSandbox.paymentSignature },
});
assert(paid.payment.simulated && !paid.payment.valueTransferred, "Sandbox receipt made a value-transfer claim");

const verified = await json<{
  valid: boolean;
  integrityOnly: boolean;
  onchain: { checked: boolean };
}>("/proofs/verify", {
  method: "POST",
  body: JSON.stringify({ packet: paid.packet }),
});
assert(verified.valid, "Portable packet did not pass deterministic verification");
assert(verified.integrityOnly && !verified.onchain.checked, "Integrity endpoint overstated an on-chain check");

const tampered = structuredClone(paid.packet);
tampered.packetHash = `0x${"0".repeat(64)}`;
const tamperedResponse = await fetch(`${base}/proofs/verify`, {
  method: "POST",
  headers: { accept: "application/json", "content-type": "application/json" },
  body: JSON.stringify({ packet: tampered }),
});
const tamperedReport = (await tamperedResponse.json()) as { valid?: boolean };
assert(tamperedResponse.status === 422 && tamperedReport.valid === false, "Tampered packet was not rejected");

process.stdout.write(
  `${JSON.stringify(
    {
      replayFrames: state.replay.totalFrames,
      conflictAtFrame4: redCard.verification.state,
      finalConfidenceBps: decision.verification.confidenceBps,
      settlementAllowed: decision.decision.allowed,
      anchorMode: decision.anchor.receipt.mode,
      x402Status: 402,
      sandboxValueTransferred: paid.payment.valueTransferred,
      packetValid: verified.valid,
      tamperRejected: true,
    },
    null,
    2,
  )}\n`,
);
