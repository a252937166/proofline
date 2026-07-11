import { randomUUID } from "node:crypto";
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

import { keccak256, stringToHex } from "viem";

import type { X402PaymentIdentity } from "./x402-ledger.js";

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const MAX_RECORDS = 256;
const MAX_RECORD_BYTES = 512 * 1_024;

export type ProofEntitlementStatus = "quoted" | "pending" | "settled";

export interface ProofEntitlementRecord {
  sessionId: string;
  packetHash: `0x${string}`;
  packet: unknown;
  quote: unknown;
  status: ProofEntitlementStatus;
  quotedAt: string;
  expiresAt?: string;
  payer?: `0x${string}`;
  nonce?: `0x${string}`;
  network?: string;
  asset?: `0x${string}`;
  amount?: string;
  paymentSignatureHash?: `0x${string}`;
  purchaseSignatureHash?: `0x${string}`;
  pendingAt?: string;
  transactionHash?: `0x${string}`;
  settledAt?: string;
  deliveredAt?: string;
}

export interface FreezeProofQuoteInput {
  sessionId: string;
  packetHash: `0x${string}`;
  packet: unknown;
  quote: unknown;
  quotedAt?: Date;
  expiresAt?: Date;
}

export type ProofEntitlementDecision =
  | { status: "missing" }
  | { status: "started"; record: ProofEntitlementRecord }
  | {
      status: "pending" | "settled";
      record: ProofEntitlementRecord;
      conflict: "proof" | "nonce";
      sameAuthorization: boolean;
      samePayer: boolean;
    };

interface PersistedStore {
  schema: "proofline.proof-entitlements.v1";
  updatedAt: string;
  records: ProofEntitlementRecord[];
}

function quoteKey(sessionId: string, packetHash: string): string {
  return `${sessionId}:${packetHash.toLowerCase()}`;
}

function nonceKey(identity: X402PaymentIdentity): string {
  return [
    identity.network.toLowerCase(),
    identity.asset.toLowerCase(),
    identity.payer.toLowerCase(),
    identity.nonce.toLowerCase(),
  ].join(":");
}

export function paymentSignatureHash(header: string): `0x${string}` {
  return keccak256(stringToHex(header));
}

function cloneJson(value: unknown, label: string): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_RECORD_BYTES) {
    throw new Error(`${label} must be JSON and no larger than ${MAX_RECORD_BYTES} bytes`);
  }
  return JSON.parse(encoded) as unknown;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validRecord(value: unknown): value is ProofEntitlementRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ProofEntitlementRecord>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    typeof record.packetHash !== "string" ||
    !BYTES32_PATTERN.test(record.packetHash) ||
    !validDate(record.quotedAt) ||
    (record.expiresAt !== undefined && !validDate(record.expiresAt)) ||
    (record.deliveredAt !== undefined && !validDate(record.deliveredAt)) ||
    !["quoted", "pending", "settled"].includes(record.status ?? "")
  ) {
    return false;
  }
  try {
    cloneJson(record.packet, "packet");
    cloneJson(record.quote, "quote");
  } catch {
    return false;
  }
  const packetHash =
    record.packet && typeof record.packet === "object" && !Array.isArray(record.packet)
      ? (record.packet as Record<string, unknown>).packetHash
      : undefined;
  if (
    typeof packetHash !== "string" ||
    packetHash.toLowerCase() !== record.packetHash.toLowerCase()
  ) {
    return false;
  }
  if (record.status === "quoted") {
    return (
      record.payer === undefined &&
      record.nonce === undefined &&
      record.paymentSignatureHash === undefined &&
      record.purchaseSignatureHash === undefined &&
      record.transactionHash === undefined &&
      record.deliveredAt === undefined
    );
  }
  if (
    typeof record.payer !== "string" ||
    !ADDRESS_PATTERN.test(record.payer) ||
    typeof record.nonce !== "string" ||
    !BYTES32_PATTERN.test(record.nonce) ||
    typeof record.network !== "string" ||
    typeof record.asset !== "string" ||
    !ADDRESS_PATTERN.test(record.asset) ||
    typeof record.amount !== "string" ||
    !/^\d+$/.test(record.amount) ||
    typeof record.paymentSignatureHash !== "string" ||
    !BYTES32_PATTERN.test(record.paymentSignatureHash) ||
    typeof record.purchaseSignatureHash !== "string" ||
    !BYTES32_PATTERN.test(record.purchaseSignatureHash) ||
    !validDate(record.pendingAt)
  ) {
    return false;
  }
  if (record.status === "pending") {
    return (
      record.transactionHash === undefined &&
      record.settledAt === undefined &&
      record.deliveredAt === undefined
    );
  }
  return (
    typeof record.transactionHash === "string" &&
    BYTES32_PATTERN.test(record.transactionHash) &&
    validDate(record.settledAt)
  );
}

export class ProofEntitlementStore {
  readonly filePath: string | undefined;
  private readonly records = new Map<string, ProofEntitlementRecord>();
  private readonly nonceIndex = new Map<string, string>();
  private readonly signatureIndex = new Map<string, string>();

  constructor(filePath?: string) {
    this.filePath = filePath ? resolve(filePath) : undefined;
    this.load();
  }

  freezeQuote(input: FreezeProofQuoteInput): ProofEntitlementRecord {
    const packetHash = input.packetHash.toLowerCase() as `0x${string}`;
    const packet = cloneJson(input.packet, "frozen packet");
    const quote = cloneJson(input.quote, "frozen quote");
    const embeddedHash =
      packet && typeof packet === "object" && !Array.isArray(packet)
        ? (packet as Record<string, unknown>).packetHash
        : undefined;
    if (
      typeof embeddedHash !== "string" ||
      embeddedHash.toLowerCase() !== packetHash
    ) {
      throw new Error("Frozen packet JSON does not match packetHash");
    }
    const key = quoteKey(input.sessionId, packetHash);
    const existing = this.records.get(key);
    if (existing) {
      if (JSON.stringify(existing.packet) !== JSON.stringify(packet)) {
        throw new Error("A frozen packet cannot be rebound to different JSON");
      }
      if (existing.status === "quoted") {
        const refreshed: ProofEntitlementRecord = {
          ...existing,
          quote,
          quotedAt: (input.quotedAt ?? new Date()).toISOString(),
          ...(input.expiresAt
            ? { expiresAt: input.expiresAt.toISOString() }
            : {}),
        };
        this.records.set(key, refreshed);
        try {
          this.persist();
        } catch (error) {
          this.records.set(key, existing);
          throw error;
        }
        return refreshed;
      }
      return existing;
    }
    if (this.records.size >= MAX_RECORDS) {
      throw new Error("Proof entitlement store reached its safety limit");
    }
    const record: ProofEntitlementRecord = {
      sessionId: input.sessionId,
      packetHash,
      packet,
      quote,
      status: "quoted",
      quotedAt: (input.quotedAt ?? new Date()).toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt.toISOString() } : {}),
    };
    this.records.set(key, record);
    try {
      this.persist();
    } catch (error) {
      this.records.delete(key);
      throw error;
    }
    return record;
  }

  beginPayment(
    identity: X402PaymentIdentity,
    rawPaymentSignatureHash: `0x${string}`,
    purchaseSignatureHash: `0x${string}`,
    now = new Date(),
  ): ProofEntitlementDecision {
    const key = quoteKey(identity.sessionId, identity.packetHash);
    const record = this.records.get(key);
    if (!record) return { status: "missing" };
    const existingNonceKey = nonceKey(identity);
    const nonceOwner = this.nonceIndex.get(existingNonceKey);
    if (nonceOwner && nonceOwner !== key) {
      const owner = this.records.get(nonceOwner);
      if (owner && owner.status !== "quoted") {
        return {
          status: owner.status,
          record: owner,
          conflict: "nonce",
          sameAuthorization:
            owner.paymentSignatureHash?.toLowerCase() ===
            rawPaymentSignatureHash.toLowerCase(),
          samePayer:
            owner.payer?.toLowerCase() === identity.payer.toLowerCase(),
        };
      }
    }
    if (record.status !== "quoted") {
      return {
        status: record.status,
        record,
        conflict: "proof",
        sameAuthorization:
          record.paymentSignatureHash?.toLowerCase() ===
          rawPaymentSignatureHash.toLowerCase(),
        samePayer: record.payer?.toLowerCase() === identity.payer.toLowerCase(),
      };
    }
    if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) {
      return { status: "missing" };
    }
    const pending: ProofEntitlementRecord = {
      ...record,
      status: "pending",
      payer: identity.payer.toLowerCase() as `0x${string}`,
      nonce: identity.nonce.toLowerCase() as `0x${string}`,
      network: identity.network,
      asset: identity.asset.toLowerCase() as `0x${string}`,
      amount: identity.amount,
      paymentSignatureHash:
        rawPaymentSignatureHash.toLowerCase() as `0x${string}`,
      purchaseSignatureHash:
        purchaseSignatureHash.toLowerCase() as `0x${string}`,
      pendingAt: now.toISOString(),
    };
    this.records.set(key, pending);
    this.nonceIndex.set(existingNonceKey, key);
    this.signatureIndex.set(pending.paymentSignatureHash!, key);
    try {
      this.persist();
    } catch (error) {
      this.records.set(key, record);
      this.nonceIndex.delete(existingNonceKey);
      this.signatureIndex.delete(pending.paymentSignatureHash!);
      throw error;
    }
    return { status: "started", record: pending };
  }

  markSettled(
    identity: X402PaymentIdentity,
    transactionHash: `0x${string}`,
    now = new Date(),
  ): ProofEntitlementRecord {
    if (!BYTES32_PATTERN.test(transactionHash)) {
      throw new Error("x402 settlement is missing a 32-byte transaction hash");
    }
    const key = quoteKey(identity.sessionId, identity.packetHash);
    const current = this.records.get(key);
    if (
      !current ||
      current.status !== "pending" ||
      current.payer?.toLowerCase() !== identity.payer.toLowerCase() ||
      current.nonce?.toLowerCase() !== identity.nonce.toLowerCase()
    ) {
      throw new Error("x402 settlement has no matching pending entitlement");
    }
    const settled: ProofEntitlementRecord = {
      ...current,
      status: "settled",
      transactionHash: transactionHash.toLowerCase() as `0x${string}`,
      settledAt: now.toISOString(),
    };
    this.records.set(key, settled);
    this.persist();
    return settled;
  }

  markDelivered(
    sessionId: string,
    packetHash: `0x${string}`,
    now = new Date(),
  ): ProofEntitlementRecord {
    const key = quoteKey(sessionId, packetHash);
    const current = this.records.get(key);
    if (!current || current.status !== "settled") {
      throw new Error("Cannot mark an unsettled proof entitlement as delivered");
    }
    const delivered: ProofEntitlementRecord = {
      ...current,
      deliveredAt: current.deliveredAt ?? now.toISOString(),
    };
    this.records.set(key, delivered);
    this.persist();
    return delivered;
  }

  releaseVerifiedRejection(identity: X402PaymentIdentity): void {
    const key = quoteKey(identity.sessionId, identity.packetHash);
    const current = this.records.get(key);
    if (!current || current.status !== "pending") return;
    const quoted: ProofEntitlementRecord = {
      sessionId: current.sessionId,
      packetHash: current.packetHash,
      packet: current.packet,
      quote: current.quote,
      status: "quoted",
      quotedAt: current.quotedAt,
      ...(current.expiresAt ? { expiresAt: current.expiresAt } : {}),
    };
    this.records.set(key, quoted);
    if (current.network && current.asset && current.payer && current.nonce) {
      this.nonceIndex.delete(
        nonceKey({
          sessionId: current.sessionId,
          packetHash: current.packetHash,
          network: current.network,
          asset: current.asset,
          amount: current.amount ?? "0",
          payer: current.payer,
          nonce: current.nonce,
        }),
      );
    }
    if (current.paymentSignatureHash) {
      this.signatureIndex.delete(current.paymentSignatureHash.toLowerCase());
    }
    try {
      this.persist();
    } catch (error) {
      this.records.set(key, current);
      if (current.network && current.asset && current.payer && current.nonce) {
        this.nonceIndex.set(
          nonceKey({
            sessionId: current.sessionId,
            packetHash: current.packetHash,
            network: current.network,
            asset: current.asset,
            amount: current.amount ?? "0",
            payer: current.payer,
            nonce: current.nonce,
          }),
          key,
        );
      }
      if (current.paymentSignatureHash) {
        this.signatureIndex.set(current.paymentSignatureHash.toLowerCase(), key);
      }
      throw error;
    }
  }

  findByPaymentSignature(
    header: string,
    sessionId?: string,
  ): ProofEntitlementRecord | undefined {
    const key = this.signatureIndex.get(paymentSignatureHash(header).toLowerCase());
    const record = key ? this.records.get(key) : undefined;
    return record && (!sessionId || record.sessionId === sessionId)
      ? record
      : undefined;
  }

  find(sessionId: string, packetHash: `0x${string}`): ProofEntitlementRecord | undefined {
    return this.records.get(quoteKey(sessionId, packetHash));
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Unable to read proof entitlement store safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const store = parsed as Partial<PersistedStore>;
    if (
      store.schema !== "proofline.proof-entitlements.v1" ||
      !Array.isArray(store.records) ||
      store.records.length > MAX_RECORDS ||
      !store.records.every(validRecord)
    ) {
      throw new Error("Proof entitlement store is invalid; refusing to start");
    }
    for (const record of store.records) {
      const key = quoteKey(record.sessionId, record.packetHash);
      if (this.records.has(key)) {
        throw new Error("Proof entitlement store contains duplicate frozen quotes");
      }
      this.records.set(key, record);
      if (
        record.status !== "quoted" &&
        record.network &&
        record.asset &&
        record.payer &&
        record.nonce &&
        record.paymentSignatureHash
      ) {
        const identity: X402PaymentIdentity = {
          sessionId: record.sessionId,
          packetHash: record.packetHash,
          payer: record.payer,
          nonce: record.nonce,
          network: record.network,
          asset: record.asset,
          amount: record.amount ?? "0",
        };
        const nonce = nonceKey(identity);
        if (this.nonceIndex.has(nonce)) {
          throw new Error("Proof entitlement store contains a duplicate USDC nonce");
        }
        if (this.signatureIndex.has(record.paymentSignatureHash.toLowerCase())) {
          throw new Error("Proof entitlement store contains a duplicate payment authorization");
        }
        this.nonceIndex.set(nonce, key);
        this.signatureIndex.set(record.paymentSignatureHash.toLowerCase(), key);
      }
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const body: PersistedStore = {
      schema: "proofline.proof-entitlements.v1",
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
        `Unable to persist proof entitlement store: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
