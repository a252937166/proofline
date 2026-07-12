import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  TEST_USDC_DISPENSER_ADDRESS_WINDOW_MS,
  TEST_USDC_DISPENSER_AMOUNT_ATOMIC,
  TEST_USDC_DISPENSER_IP_LIMIT,
} from "./config.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_RECORDS = 4_096;

export type TestUsdcClaimStatus = "pending" | "submitted" | "confirmed";

export interface TestUsdcClaimRecord {
  id: string;
  recipient: `0x${string}`;
  ipHash: string;
  amountAtomic: typeof TEST_USDC_DISPENSER_AMOUNT_ATOMIC;
  status: TestUsdcClaimStatus;
  requestedAt: string;
  transactionHash?: `0x${string}`;
  submittedAt?: string;
  confirmedAt?: string;
}

interface PersistedTestUsdcClaims {
  schema: "proofline.test-usdc-claims.v1";
  updatedAt: string;
  records: TestUsdcClaimRecord[];
}

export type TestUsdcClaimReservation =
  | { status: "started"; record: TestUsdcClaimRecord }
  | {
      status: "address-limited";
      record: TestUsdcClaimRecord;
      retryAt?: string;
    }
  | { status: "ip-limited"; retryAt?: string }
  | { status: "global-limited"; retryAt?: string };

export type TestUsdcClaimInspection =
  | { status: "available" }
  | Exclude<TestUsdcClaimReservation, { status: "started" }>;

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validRecord(value: unknown): value is TestUsdcClaimRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<TestUsdcClaimRecord>;
  const submittedFieldsValid =
    record.status === "pending"
      ? record.transactionHash === undefined &&
        record.submittedAt === undefined &&
        record.confirmedAt === undefined
      : typeof record.transactionHash === "string" &&
        TRANSACTION_HASH_PATTERN.test(record.transactionHash) &&
        validDate(record.submittedAt) &&
        (record.status === "submitted"
          ? record.confirmedAt === undefined
          : validDate(record.confirmedAt));
  return (
    typeof record.id === "string" &&
    /^[0-9a-f-]{36}$/.test(record.id) &&
    typeof record.recipient === "string" &&
    ADDRESS_PATTERN.test(record.recipient) &&
    record.recipient === record.recipient.toLowerCase() &&
    typeof record.ipHash === "string" &&
    HASH_PATTERN.test(record.ipHash) &&
    record.amountAtomic === TEST_USDC_DISPENSER_AMOUNT_ATOMIC &&
    ["pending", "submitted", "confirmed"].includes(record.status ?? "") &&
    validDate(record.requestedAt) &&
    submittedFieldsValid
  );
}

function activeAt(record: TestUsdcClaimRecord, nowMs: number): boolean {
  if (record.status !== "confirmed") return true;
  return Date.parse(record.requestedAt) + TEST_USDC_DISPENSER_ADDRESS_WINDOW_MS > nowMs;
}

function nextEligibleAt(
  records: readonly TestUsdcClaimRecord[],
): string | undefined {
  if (records.some((record) => record.status !== "confirmed")) return undefined;
  const earliest = records
    .map(
      (record) =>
        Date.parse(record.requestedAt) +
        TEST_USDC_DISPENSER_ADDRESS_WINDOW_MS,
    )
    .sort((left, right) => left - right)[0];
  return earliest === undefined ? undefined : new Date(earliest).toISOString();
}

/**
 * A single-process, crash-safe claim journal. Pending or submitted claims never
 * expire automatically: an ambiguous broadcast must be reconciled on-chain by
 * an operator before the recipient, IP, or global budget can be released.
 */
export class TestUsdcClaimStore {
  readonly filePath: string;
  private readonly records = new Map<string, TestUsdcClaimRecord>();

  constructor(
    filePath: string,
    readonly dailyClaimLimit: number,
  ) {
    this.filePath = resolve(filePath);
    this.load();
  }

  reserve(input: {
    recipient: `0x${string}`;
    ipHash: string;
    now?: Date;
  }): TestUsdcClaimReservation {
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const recipient = input.recipient.toLowerCase() as `0x${string}`;
    if (!ADDRESS_PATTERN.test(recipient) || !HASH_PATTERN.test(input.ipHash)) {
      throw new Error("Invalid test USDC claim identity");
    }

    const inspection = this.inspect({ recipient, ipHash: input.ipHash, now });
    if (inspection.status !== "available") return inspection;

    if (this.records.size >= MAX_RECORDS) {
      this.prune(nowMs);
      if (this.records.size >= MAX_RECORDS) {
        throw new Error(
          "The test USDC claim store reached its safety limit; reconcile pending claims before accepting another request",
        );
      }
    }

    const record: TestUsdcClaimRecord = {
      id: randomUUID(),
      recipient,
      ipHash: input.ipHash,
      amountAtomic: TEST_USDC_DISPENSER_AMOUNT_ATOMIC,
      status: "pending",
      requestedAt: now.toISOString(),
    };
    this.records.set(record.id, record);
    try {
      this.persist();
    } catch (error) {
      this.records.delete(record.id);
      throw error;
    }
    return { status: "started", record: structuredClone(record) };
  }

  inspect(input: {
    recipient: `0x${string}`;
    ipHash: string;
    now?: Date;
  }): TestUsdcClaimInspection {
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const recipient = input.recipient.toLowerCase() as `0x${string}`;
    if (!ADDRESS_PATTERN.test(recipient) || !HASH_PATTERN.test(input.ipHash)) {
      throw new Error("Invalid test USDC claim identity");
    }

    const active = [...this.records.values()].filter((record) =>
      activeAt(record, nowMs),
    );
    const sameAddress = active.filter(
      (record) => record.recipient === recipient,
    );
    if (sameAddress.length > 0) {
      const retryAt = nextEligibleAt(sameAddress);
      return {
        status: "address-limited",
        record: sameAddress[0]!,
        ...(retryAt ? { retryAt } : {}),
      };
    }

    const sameIp = active.filter((record) => record.ipHash === input.ipHash);
    if (sameIp.length >= TEST_USDC_DISPENSER_IP_LIMIT) {
      const retryAt = nextEligibleAt(sameIp);
      return {
        status: "ip-limited",
        ...(retryAt ? { retryAt } : {}),
      };
    }
    if (active.length >= this.dailyClaimLimit) {
      const retryAt = nextEligibleAt(active);
      return {
        status: "global-limited",
        ...(retryAt ? { retryAt } : {}),
      };
    }
    return { status: "available" };
  }

  markSubmitted(
    id: string,
    transactionHash: `0x${string}`,
    now = new Date(),
  ): TestUsdcClaimRecord {
    if (!TRANSACTION_HASH_PATTERN.test(transactionHash)) {
      throw new Error("The test USDC transfer is missing a transaction hash");
    }
    const current = this.records.get(id);
    if (!current || current.status !== "pending") {
      throw new Error("The test USDC claim has no matching pending record");
    }
    const submitted: TestUsdcClaimRecord = {
      ...current,
      status: "submitted",
      transactionHash: transactionHash.toLowerCase() as `0x${string}`,
      submittedAt: now.toISOString(),
    };
    this.records.set(id, submitted);
    this.persist();
    return structuredClone(submitted);
  }

  markConfirmed(id: string, now = new Date()): TestUsdcClaimRecord {
    const current = this.records.get(id);
    if (!current || current.status !== "submitted") {
      throw new Error("The test USDC claim has no matching submitted record");
    }
    const confirmed: TestUsdcClaimRecord = {
      ...current,
      status: "confirmed",
      confirmedAt: now.toISOString(),
    };
    this.records.set(id, confirmed);
    this.persist();
    return structuredClone(confirmed);
  }

  private prune(nowMs: number): void {
    const retentionMs = TEST_USDC_DISPENSER_ADDRESS_WINDOW_MS * 2;
    for (const [id, record] of this.records) {
      if (
        record.status === "confirmed" &&
        Date.parse(record.requestedAt) + retentionMs <= nowMs
      ) {
        this.records.delete(id);
      }
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Unable to read test USDC claim store safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const store = parsed as Partial<PersistedTestUsdcClaims>;
    if (
      store.schema !== "proofline.test-usdc-claims.v1" ||
      !Array.isArray(store.records) ||
      store.records.length > MAX_RECORDS ||
      !store.records.every(validRecord)
    ) {
      throw new Error("The test USDC claim store is invalid; refusing to start");
    }
    for (const source of store.records) {
      if (this.records.has(source.id)) {
        throw new Error(
          "The test USDC claim store contains duplicate records; refusing to start",
        );
      }
      this.records.set(source.id, structuredClone(source));
    }
  }

  private persist(): void {
    if (this.records.size > MAX_RECORDS) {
      throw new Error("The test USDC claim store is full");
    }
    const body: PersistedTestUsdcClaims = {
      schema: "proofline.test-usdc-claims.v1",
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
      const temporaryHandle = openSync(temporary, "r");
      try {
        fsyncSync(temporaryHandle);
      } finally {
        closeSync(temporaryHandle);
      }
      renameSync(temporary, this.filePath);
      chmodSync(this.filePath, 0o600);
      const parentHandle = openSync(parent, "r");
      try {
        fsyncSync(parentHandle);
      } finally {
        closeSync(parentHandle);
      }
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new Error(
        `Unable to persist test USDC claims safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
