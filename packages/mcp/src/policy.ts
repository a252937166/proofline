import type { ApiResponse } from "./api.js";

const USDC_DECIMALS = 6;
const HARD_MAX_PER_PROOF = 20_000n; // 0.02 USDC
const HARD_MAX_PER_SESSION = 100_000n; // 0.10 USDC
const INJECTIVE_TESTNET = "eip155:1439";
const DEFAULT_INJECTIVE_TESTNET_USDC = "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d";
const DEMO_SANDBOX_PAYEE = "0x0000000000000000000000000000000000000000";

export interface PaymentRequirement {
  network: string;
  asset: string;
  payee: string;
  amountMicrounits: bigint;
  scheme?: string;
  raw: Record<string, unknown>;
}

export interface PolicySnapshot {
  network: string;
  asset: string;
  payeeConfigured: boolean;
  perProofLimitUsdc: string;
  sessionLimitUsdc: string;
  sessionSpentUsdc: string;
  sessionRemainingUsdc: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function parseUsdc(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`Invalid USDC amount: ${value}`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
}

export function formatUsdc(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function amountMicrounits(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value < 1 ? parseUsdc(String(value)) : BigInt(Math.trunc(value));
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) return BigInt(normalized);
  if (/^\d+\.\d{1,6}$/.test(normalized)) return parseUsdc(normalized);
  return undefined;
}

function decodePaymentRequiredHeader(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function walkRequirements(value: unknown, results: Record<string, unknown>[], depth = 0): void {
  if (depth > 7 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) walkRequirements(item, results, depth + 1);
    return;
  }
  const item = record(value);
  if (!item) return;

  const hasNetwork = text(item.network) !== undefined;
  const hasRecipient = text(item.payTo) !== undefined || text(item.payee) !== undefined;
  const hasAmount =
    item.maxAmountRequired !== undefined || item.amount !== undefined || item.priceAtomic !== undefined;
  if (hasNetwork && hasRecipient && hasAmount) results.push(item);

  for (const child of Object.values(item)) walkRequirements(child, results, depth + 1);
}

export function extractPaymentRequirements(response: ApiResponse): PaymentRequirement[] {
  const candidates: Record<string, unknown>[] = [];
  walkRequirements(response.data, candidates);
  walkRequirements(decodePaymentRequiredHeader(response.headers["payment-required"]), candidates);

  const normalized: PaymentRequirement[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const network = text(item.network);
    const assetValue = record(item.asset)?.address ?? item.asset;
    const asset = text(assetValue);
    const payee = text(item.payTo) ?? text(item.payee) ?? text(item.recipient);
    const amount = amountMicrounits(item.maxAmountRequired ?? item.amount ?? item.priceAtomic);
    if (!network || !asset || !payee || amount === undefined) continue;
    const scheme = text(item.scheme);
    const key = `${network}:${asset.toLowerCase()}:${payee.toLowerCase()}:${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      network,
      asset,
      payee,
      amountMicrounits: amount,
      ...(scheme ? { scheme } : {}),
      raw: item,
    });
  }
  return normalized;
}

function address(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an EVM address`);
  return value.toLowerCase();
}

function configuredLimit(name: string, fallback: bigint, hardMaximum: bigint): bigint {
  const value = process.env[name] ? parseUsdc(process.env[name] as string) : fallback;
  if (value <= 0n || value > hardMaximum) {
    throw new Error(`${name} must be positive and no greater than ${formatUsdc(hardMaximum)} USDC`);
  }
  return value;
}

export class SpendPolicy {
  readonly network = INJECTIVE_TESTNET;
  readonly asset: string;
  readonly payee: string | undefined;
  readonly perProofLimit: bigint;
  readonly sessionLimit: bigint;
  private sessionSpent = 0n;

  constructor() {
    const configuredNetwork = process.env.PROOFLINE_ALLOWED_NETWORK ?? INJECTIVE_TESTNET;
    if (configuredNetwork !== INJECTIVE_TESTNET) {
      throw new Error("MCP purchases are hard-limited to Injective EVM testnet eip155:1439");
    }
    const configuredAsset = address(
      process.env.PROOFLINE_ALLOWED_USDC_ADDRESS ??
        process.env.X402_USDC_ADDRESS ??
        DEFAULT_INJECTIVE_TESTNET_USDC,
      "Allowed USDC asset",
    );
    this.asset = address(DEFAULT_INJECTIVE_TESTNET_USDC, "Canonical testnet USDC");
    if (configuredAsset !== this.asset) {
      throw new Error(
        "MCP purchases are hard-limited to the canonical Injective testnet native USDC contract",
      );
    }
    const configuredPayee = process.env.PROOFLINE_ALLOWED_PAYEE ?? process.env.X402_PAY_TO;
    this.payee = configuredPayee ? address(configuredPayee, "Allowed x402 payee") : undefined;
    this.perProofLimit = configuredLimit(
      "PROOFLINE_MAX_PROOF_USDC",
      HARD_MAX_PER_PROOF,
      HARD_MAX_PER_PROOF,
    );
    this.sessionLimit = configuredLimit(
      "PROOFLINE_MAX_SESSION_USDC",
      HARD_MAX_PER_SESSION,
      HARD_MAX_PER_SESSION,
    );
  }

  snapshot(): PolicySnapshot {
    return {
      network: this.network,
      asset: this.asset,
      payeeConfigured: this.payee !== undefined,
      perProofLimitUsdc: formatUsdc(this.perProofLimit),
      sessionLimitUsdc: formatUsdc(this.sessionLimit),
      sessionSpentUsdc: formatUsdc(this.sessionSpent),
      sessionRemainingUsdc: formatUsdc(this.sessionLimit - this.sessionSpent),
    };
  }

  validate(requirement: PaymentRequirement, sandbox = false): void {
    if (requirement.scheme !== "exact") {
      throw new Error("Refusing an x402 requirement whose scheme is not exact");
    }
    if (requirement.network !== this.network) {
      throw new Error(`Refusing x402 network ${requirement.network}; only ${this.network} is allowed`);
    }
    if (address(requirement.asset, "Quoted asset") !== this.asset) {
      throw new Error("Refusing x402 quote for an asset other than configured Injective testnet USDC");
    }
    const expectedPayee = sandbox ? DEMO_SANDBOX_PAYEE : this.payee;
    if (!expectedPayee) {
      throw new Error("Set PROOFLINE_ALLOWED_PAYEE or X402_PAY_TO before any real paid proof request");
    }
    if (address(requirement.payee, "Quoted payee") !== expectedPayee) {
      throw new Error("Refusing x402 quote whose payee differs from the configured Proofline payee");
    }
    if (requirement.amountMicrounits <= 0n || requirement.amountMicrounits > this.perProofLimit) {
      throw new Error(
        `Proof price ${formatUsdc(requirement.amountMicrounits)} exceeds the ${formatUsdc(this.perProofLimit)} USDC per-proof policy`,
      );
    }
    if (this.sessionSpent + requirement.amountMicrounits > this.sessionLimit) {
      throw new Error(
        `Purchase would exceed the ${formatUsdc(this.sessionLimit)} USDC MCP-session policy`,
      );
    }
  }

  reserve(requirement: PaymentRequirement, approved: boolean, sandbox = false): PolicySnapshot {
    if (!approved) throw new Error("purchase_match_proof requires approved=true after reviewing the quote");
    this.validate(requirement, sandbox);
    if (sandbox) return this.snapshot();
    // Reserve before network I/O. A failed response does not prove that a signed
    // payment was not settled, so conservative accounting does not roll back.
    this.sessionSpent += requirement.amountMicrounits;
    return this.snapshot();
  }
}

export function publicRequirement(requirement: PaymentRequirement): Record<string, unknown> {
  return {
    network: requirement.network,
    asset: requirement.asset,
    payee: requirement.payee,
    amountUsdc: formatUsdc(requirement.amountMicrounits),
    ...(requirement.scheme ? { scheme: requirement.scheme } : {}),
  };
}
