import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_HEADER_BYTES = 32_768;
const MAX_LEDGER_RECORDS = 1_024;

export interface X402PaymentIdentity {
  sessionId: string;
  packetHash: `0x${string}`;
  payer: `0x${string}`;
  nonce: `0x${string}`;
  network: string;
  asset: `0x${string}`;
  amount: string;
}

export interface X402LedgerRecord extends X402PaymentIdentity {
  status: "pending" | "settled";
  pendingAt: string;
  settledAt?: string;
  transactionHash?: `0x${string}`;
}

export type X402LedgerDecision =
  | { status: "clear" }
  | { status: "started"; record: X402LedgerRecord }
  | { status: "pending"; record: X402LedgerRecord; conflict: "proof" | "nonce" }
  | { status: "settled"; record: X402LedgerRecord; conflict: "proof" | "nonce" };

interface PersistedLedger {
  schema: "proofline.x402-ledger.v1";
  updatedAt: string;
  records: X402LedgerRecord[];
}

function normalizedIdentity(identity: X402PaymentIdentity): X402PaymentIdentity {
  return {
    ...identity,
    packetHash: identity.packetHash.toLowerCase() as `0x${string}`,
    payer: identity.payer.toLowerCase() as `0x${string}`,
    nonce: identity.nonce.toLowerCase() as `0x${string}`,
    asset: identity.asset.toLowerCase() as `0x${string}`,
  };
}

function proofKey(identity: X402PaymentIdentity): string {
  return [
    identity.sessionId,
    identity.packetHash.toLowerCase(),
    identity.payer.toLowerCase(),
  ].join(":");
}

function nonceKey(identity: X402PaymentIdentity): string {
  // EIP-3009 authorizationState is scoped by token + authorizer + nonce.
  return [
    identity.network.toLowerCase(),
    identity.asset.toLowerCase(),
    identity.payer.toLowerCase(),
    identity.nonce.toLowerCase(),
  ].join(":");
}

function validRecord(value: unknown): value is X402LedgerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<X402LedgerRecord>;
  return (
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    typeof record.packetHash === "string" &&
    BYTES32_PATTERN.test(record.packetHash) &&
    typeof record.payer === "string" &&
    ADDRESS_PATTERN.test(record.payer) &&
    typeof record.nonce === "string" &&
    BYTES32_PATTERN.test(record.nonce) &&
    typeof record.network === "string" &&
    record.network.length > 0 &&
    typeof record.asset === "string" &&
    ADDRESS_PATTERN.test(record.asset) &&
    typeof record.amount === "string" &&
    /^\d+$/.test(record.amount) &&
    (record.status === "pending" || record.status === "settled") &&
    typeof record.pendingAt === "string" &&
    !Number.isNaN(Date.parse(record.pendingAt)) &&
    (record.status !== "settled" ||
      (typeof record.settledAt === "string" &&
        !Number.isNaN(Date.parse(record.settledAt)) &&
        typeof record.transactionHash === "string" &&
        BYTES32_PATTERN.test(record.transactionHash)))
  );
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parse only the identity needed for replay protection. Cryptographic and
 * payment-requirement validation remains the responsibility of the official
 * @injectivelabs/x402 middleware.
 */
export function parseX402PaymentIdentity(
  header: string | undefined,
  sessionId: string,
): X402PaymentIdentity | undefined {
  if (!header || header.length > MAX_HEADER_BYTES) return undefined;
  try {
    const decoded = Buffer.from(header, "base64").toString("utf8");
    if (!decoded || Buffer.byteLength(decoded) > MAX_HEADER_BYTES) return undefined;
    const root = parseObject(JSON.parse(decoded));
    const accepted = parseObject(root?.accepted);
    const payload = parseObject(root?.payload);
    const authorization = parseObject(payload?.authorization);
    const extra = parseObject(accepted?.extra);
    const extensions = parseObject(root?.extensions);
    const proofline = parseObject(extensions?.proofline);
    const acceptedPacketHash = extra?.prooflineQuoteId;
    const extensionPacketHash = proofline?.packetHash;
    if (
      extensionPacketHash !== undefined &&
      acceptedPacketHash !== undefined &&
      extensionPacketHash !== acceptedPacketHash
    ) {
      return undefined;
    }
    const packetHash = acceptedPacketHash ?? extensionPacketHash;
    const payer = authorization?.from;
    const nonce = authorization?.nonce;
    const network = accepted?.network;
    const asset = accepted?.asset;
    const amount = accepted?.amount;
    if (
      root?.x402Version !== 2 ||
      typeof packetHash !== "string" ||
      !BYTES32_PATTERN.test(packetHash) ||
      typeof payer !== "string" ||
      !ADDRESS_PATTERN.test(payer) ||
      typeof nonce !== "string" ||
      !BYTES32_PATTERN.test(nonce) ||
      typeof network !== "string" ||
      network.length === 0 ||
      typeof asset !== "string" ||
      !ADDRESS_PATTERN.test(asset) ||
      typeof amount !== "string" ||
      !/^\d+$/.test(amount)
    ) {
      return undefined;
    }
    return normalizedIdentity({
      sessionId,
      packetHash: packetHash as `0x${string}`,
      payer: payer as `0x${string}`,
      nonce: nonce as `0x${string}`,
      network,
      asset: asset as `0x${string}`,
      amount,
    });
  } catch {
    return undefined;
  }
}

/**
 * Tiny crash-safe settlement journal. Pending records never expire
 * automatically: after an ambiguous facilitator/RPC outcome, retrying the same
 * authorization could double-deliver or obscure a payment that landed. An
 * operator must establish chain state before clearing such a record.
 */
export class X402SettlementLedger {
  readonly filePath: string | undefined;
  private readonly records = new Map<string, X402LedgerRecord>();
  private readonly nonceIndex = new Map<string, string>();

  constructor(filePath?: string) {
    this.filePath = filePath ? resolve(filePath) : undefined;
    this.load();
  }

  inspect(identityInput: X402PaymentIdentity): X402LedgerDecision {
    const identity = normalizedIdentity(identityInput);
    const key = proofKey(identity);
    const sameProof = this.records.get(key);
    if (sameProof) {
      return {
        status: sameProof.status,
        record: sameProof,
        conflict: "proof",
      };
    }
    const nonceOwner = this.nonceIndex.get(nonceKey(identity));
    const sameNonce = nonceOwner ? this.records.get(nonceOwner) : undefined;
    if (sameNonce) {
      return {
        status: sameNonce.status,
        record: sameNonce,
        conflict: "nonce",
      };
    }
    return { status: "clear" };
  }

  begin(identityInput: X402PaymentIdentity, now = new Date()): X402LedgerDecision {
    const identity = normalizedIdentity(identityInput);
    const existing = this.inspect(identity);
    if (existing.status !== "clear") return existing;
    if (this.records.size >= MAX_LEDGER_RECORDS) {
      throw new Error(
        "The x402 settlement ledger reached its safety limit; reconcile old records before accepting another payment",
      );
    }

    const record: X402LedgerRecord = {
      ...identity,
      status: "pending",
      pendingAt: now.toISOString(),
    };
    const key = proofKey(record);
    this.records.set(key, record);
    this.nonceIndex.set(nonceKey(record), key);
    try {
      this.persist();
    } catch (error) {
      // No facilitator call has happened yet, so reverting the in-memory claim
      // is safe. The atomic file writer leaves the previous durable state intact.
      this.records.delete(key);
      this.nonceIndex.delete(nonceKey(record));
      throw error;
    }
    return { status: "started", record };
  }

  markSettled(
    identityInput: X402PaymentIdentity,
    transactionHash: `0x${string}`,
    now = new Date(),
  ): X402LedgerRecord {
    if (!BYTES32_PATTERN.test(transactionHash)) {
      throw new Error("x402 settlement is missing a 32-byte transaction hash");
    }
    const identity = normalizedIdentity(identityInput);
    const key = proofKey(identity);
    const current = this.records.get(key);
    if (!current || current.status !== "pending") {
      throw new Error("x402 settlement has no matching pending ledger record");
    }
    const settled: X402LedgerRecord = {
      ...current,
      status: "settled",
      settledAt: now.toISOString(),
      transactionHash: transactionHash.toLowerCase() as `0x${string}`,
    };
    this.records.set(key, settled);
    // Keep settled in memory even if persistence fails. A retry in this process
    // must never call the facilitator again; the durable pending entry also
    // remains fail-closed after a restart.
    this.persist();
    return settled;
  }

  /** Release only a clearly pre-settlement verification rejection. */
  releaseUnsettled(identityInput: X402PaymentIdentity): void {
    const identity = normalizedIdentity(identityInput);
    const key = proofKey(identity);
    const current = this.records.get(key);
    if (!current || current.status !== "pending") return;
    this.records.delete(key);
    this.nonceIndex.delete(nonceKey(current));
    try {
      this.persist();
    } catch (error) {
      // Restoring pending mirrors the still-durable state and remains fail closed.
      this.records.set(key, current);
      this.nonceIndex.set(nonceKey(current), key);
      throw error;
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Unable to read x402 settlement ledger safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const ledger = parsed as Partial<PersistedLedger>;
    if (
      ledger.schema !== "proofline.x402-ledger.v1" ||
      !Array.isArray(ledger.records) ||
      ledger.records.length > MAX_LEDGER_RECORDS ||
      !ledger.records.every(validRecord)
    ) {
      throw new Error("The x402 settlement ledger is invalid; refusing to start");
    }
    for (const source of ledger.records) {
      const record = {
        ...source,
        ...normalizedIdentity(source),
      } as X402LedgerRecord;
      const key = proofKey(record);
      const nonce = nonceKey(record);
      if (this.records.has(key) || this.nonceIndex.has(nonce)) {
        throw new Error(
          "The x402 settlement ledger contains duplicate proof or nonce records; refusing to start",
        );
      }
      this.records.set(key, record);
      this.nonceIndex.set(nonce, key);
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    if (this.records.size > MAX_LEDGER_RECORDS) {
      throw new Error(
        "The x402 settlement ledger is full of unresolved payments; refusing new settlement",
      );
    }

    const body: PersistedLedger = {
      schema: "proofline.x402-ledger.v1",
      updatedAt: new Date().toISOString(),
      records: [...this.records.values()],
    };
    const parent = dirname(this.filePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new Error(
        `Unable to persist x402 settlement ledger: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
