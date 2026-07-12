import { createHmac } from "node:crypto";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  INJECTIVE_TESTNET_NETWORK,
  INJECTIVE_TESTNET_USDC,
  TEST_USDC_DISPENSER_ADDRESS_WINDOW_MS,
  TEST_USDC_DISPENSER_AMOUNT_ATOMIC,
  TEST_USDC_DISPENSER_IP_LIMIT,
  TEST_USDC_DISPENSER_MINIMUM_BALANCE_ATOMIC,
  type TestUsdcDispenserRuntimeConfig,
} from "./config.js";
import {
  TestUsdcClaimStore,
  type TestUsdcClaimInspection,
  type TestUsdcClaimRecord,
  type TestUsdcClaimReservation,
} from "./test-usdc-dispenser-store.js";

const DISPENSER_AMOUNT = BigInt(TEST_USDC_DISPENSER_AMOUNT_ATOMIC);
const MINIMUM_USEFUL_BALANCE = BigInt(
  TEST_USDC_DISPENSER_MINIMUM_BALANCE_ATOMIC,
);
const RECEIPT_TIMEOUT_MS = 25_000;

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export type TestUsdcDispenserErrorCode =
  | "invalid_recipient"
  | "dispenser_disabled"
  | "dispenser_misconfigured"
  | "already_funded"
  | "address_cooldown"
  | "ip_limit"
  | "global_limit"
  | "treasury_low"
  | "rpc_unavailable"
  | "claim_pending";

export class TestUsdcDispenserError extends Error {
  constructor(
    readonly code: TestUsdcDispenserErrorCode,
    readonly httpStatus: 400 | 409 | 429 | 503,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TestUsdcDispenserError";
  }
}

export interface TestUsdcClaimResponse {
  schema: "proofline.test-usdc-claim.v1";
  status: "submitted" | "confirmed";
  network: typeof INJECTIVE_TESTNET_NETWORK;
  chainId: 1439;
  asset: {
    symbol: "USDC";
    address: typeof INJECTIVE_TESTNET_USDC;
    decimals: 6;
  };
  recipient: `0x${string}`;
  amountAtomic: typeof TEST_USDC_DISPENSER_AMOUNT_ATOMIC;
  amountDisplay: "0.02 test USDC";
  transactionHash: `0x${string}`;
  explorerUrl: string;
  requestedAt: string;
  submittedAt: string;
  confirmedAt?: string;
  nextEligibleAt: string;
}

export interface TestUsdcDispenserPublicStatus {
  mode: "disabled" | "enabled";
  status: "disabled" | "misconfigured" | "configured-unverified";
  configured: boolean;
  network: typeof INJECTIVE_TESTNET_NETWORK;
  chainId: 1439;
  asset: {
    symbol: "USDC";
    address: typeof INJECTIVE_TESTNET_USDC;
    decimals: 6;
  };
  amountAtomic: typeof TEST_USDC_DISPENSER_AMOUNT_ATOMIC;
  amountDisplay: "0.02 test USDC";
  limits: {
    addressWindowHours: 24;
    ipClaimsPerWindow: typeof TEST_USDC_DISPENSER_IP_LIMIT;
    globalClaimsPerWindow: number;
  };
  disclosure: string;
}

export interface TestUsdcClaimInput {
  recipient: unknown;
  ip: string;
  now?: Date;
}

export interface TestUsdcDispenser {
  status(): TestUsdcDispenserPublicStatus;
  claim(input: TestUsdcClaimInput): Promise<TestUsdcClaimResponse>;
}

export interface TestUsdcChainClient {
  preflight(recipient: Address): Promise<void>;
  broadcast(recipient: Address): Promise<Hex>;
  waitForConfirmation(transactionHash: Hex): Promise<boolean>;
}

class ViemTestUsdcChainClient implements TestUsdcChainClient {
  private readonly account;
  private readonly chain;
  private readonly publicClient;
  private readonly walletClient;

  constructor(private readonly config: TestUsdcDispenserRuntimeConfig) {
    if (!config.privateKey) {
      throw new Error("The test USDC dispenser wallet key is unavailable");
    }
    this.account = privateKeyToAccount(config.privateKey);
    this.chain = defineChain({
      id: 1_439,
      name: "Injective EVM Testnet",
      nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
      testnet: true,
    });
    const transport = http(config.rpcUrl, { retryCount: 1, timeout: 10_000 });
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport,
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport,
    });
  }

  async preflight(recipient: Address): Promise<void> {
    try {
      const [chainId, code, decimals, recipientBalance, treasuryBalance, gas] =
        await Promise.all([
          this.publicClient.getChainId(),
          this.publicClient.getCode({ address: INJECTIVE_TESTNET_USDC }),
          this.publicClient.readContract({
            address: INJECTIVE_TESTNET_USDC,
            abi: erc20Abi,
            functionName: "decimals",
          }),
          this.publicClient.readContract({
            address: INJECTIVE_TESTNET_USDC,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [recipient],
          }),
          this.publicClient.readContract({
            address: INJECTIVE_TESTNET_USDC,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.account.address],
          }),
          this.publicClient.getBalance({ address: this.account.address }),
        ]);
      if (
        chainId !== 1_439 ||
        !code ||
        code === "0x" ||
        decimals !== 6
      ) {
        throw new TestUsdcDispenserError(
          "rpc_unavailable",
          503,
          "The dispenser RPC or canonical test USDC contract failed its Injective testnet identity check.",
        );
      }
      if (recipientBalance >= MINIMUM_USEFUL_BALANCE) {
        throw new TestUsdcDispenserError(
          "already_funded",
          409,
          "This address already has enough test USDC for the 0.01 test-USDC proof.",
        );
      }
      if (treasuryBalance < DISPENSER_AMOUNT || gas === 0n) {
        throw new TestUsdcDispenserError(
          "treasury_low",
          503,
          "The judge test-USDC dispenser is temporarily underfunded.",
        );
      }
      const simulation = await this.publicClient.simulateContract({
        account: this.account,
        address: INJECTIVE_TESTNET_USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient, DISPENSER_AMOUNT],
      });
      if (simulation.result !== true) {
        throw new TestUsdcDispenserError(
          "treasury_low",
          503,
          "The canonical test-USDC contract did not accept the dispenser transfer simulation.",
        );
      }
    } catch (error) {
      if (error instanceof TestUsdcDispenserError) throw error;
      throw new TestUsdcDispenserError(
        "rpc_unavailable",
        503,
        "The judge test-USDC dispenser could not complete its testnet preflight.",
      );
    }
  }

  async broadcast(recipient: Address): Promise<Hex> {
    return this.walletClient.writeContract({
      account: this.account,
      chain: this.chain,
      address: INJECTIVE_TESTNET_USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, DISPENSER_AMOUNT],
    });
  }

  async waitForConfirmation(transactionHash: Hex): Promise<boolean> {
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: transactionHash,
        confirmations: 1,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success";
    } catch {
      return false;
    }
  }
}

class RuntimeTestUsdcDispenser implements TestUsdcDispenser {
  private queue: Promise<void> = Promise.resolve();
  private readonly store: TestUsdcClaimStore;

  constructor(
    private readonly config: TestUsdcDispenserRuntimeConfig,
    private readonly chainClient: TestUsdcChainClient,
  ) {
    if (!config.stateFile || !config.ipHashKey) {
      throw new Error("The configured test USDC dispenser is incomplete");
    }
    this.store = new TestUsdcClaimStore(
      config.stateFile,
      config.dailyClaimLimit,
    );
  }

  status(): TestUsdcDispenserPublicStatus {
    return publicStatus(this.config);
  }

  claim(input: TestUsdcClaimInput): Promise<TestUsdcClaimResponse> {
    const submitted = this.queue.then(
      () => this.submitSerial(input),
      () => this.submitSerial(input),
    );
    // Only preflight, reservation, broadcast, and durable markSubmitted need
    // serialization for nonce safety. Receipt waits can run concurrently so a
    // slow confirmation never keeps later requests behind a 25-second lock.
    this.queue = submitted.then(
      () => undefined,
      () => undefined,
    );
    return submitted.then(async (record) => {
      let finalRecord = record;
      if (await this.chainClient.waitForConfirmation(record.transactionHash!)) {
        try {
          finalRecord = this.store.markConfirmed(record.id, new Date());
        } catch {
          // The durable submitted record and transaction hash remain sufficient
          // to prevent a duplicate transfer after a persistence failure.
        }
      }
      return claimResponse(finalRecord, this.config.explorerUrl);
    });
  }

  private async submitSerial(
    input: TestUsdcClaimInput,
  ): Promise<TestUsdcClaimRecord> {
    const recipient = normalizedRecipient(input.recipient);
    const now = input.now ?? new Date();
    const ipHash = createHmac("sha256", this.config.ipHashKey!)
      .update(normalizedIp(input.ip))
      .digest("hex");
    const inspection = this.store.inspect({ recipient, ipHash, now });
    if (inspection.status !== "available") {
      throwForClaimLimit(inspection, now);
    }

    await this.chainClient.preflight(recipient);
    const reservation = this.store.reserve({ recipient, ipHash, now });
    if (reservation.status !== "started") {
      throwForClaimLimit(reservation, now);
    }

    let transactionHash: Hex;
    try {
      transactionHash = await this.chainClient.broadcast(recipient);
    } catch {
      throw new TestUsdcDispenserError(
        "claim_pending",
        409,
        "The dispenser could not prove whether the test-USDC transfer was broadcast. The durable pending claim remains blocked for operator reconciliation; do not retry with another request.",
      );
    }

    let record: TestUsdcClaimRecord;
    try {
      record = this.store.markSubmitted(
        reservation.record.id,
        transactionHash,
        new Date(),
      );
    } catch {
      throw new TestUsdcDispenserError(
        "claim_pending",
        409,
        "The test-USDC transaction may have been broadcast, but its durable submitted state could not be recorded. The prior pending record remains fail-closed.",
      );
    }

    return record;
  }
}

class UnavailableTestUsdcDispenser implements TestUsdcDispenser {
  constructor(private readonly config: TestUsdcDispenserRuntimeConfig) {}

  status(): TestUsdcDispenserPublicStatus {
    return publicStatus(this.config);
  }

  async claim(): Promise<TestUsdcClaimResponse> {
    throw new TestUsdcDispenserError(
      this.config.enabled ? "dispenser_misconfigured" : "dispenser_disabled",
      503,
      this.config.enabled
        ? "The judge test-USDC dispenser is enabled but its dedicated wallet, IP hash key, or durable state file is incomplete."
        : "The judge test-USDC dispenser is disabled.",
    );
  }
}

function publicStatus(
  config: TestUsdcDispenserRuntimeConfig,
): TestUsdcDispenserPublicStatus {
  return {
    mode: config.enabled ? "enabled" : "disabled",
    status: config.enabled
      ? config.configured
        ? "configured-unverified"
        : "misconfigured"
      : "disabled",
    configured: config.configured,
    network: INJECTIVE_TESTNET_NETWORK,
    chainId: 1_439,
    asset: {
      symbol: "USDC",
      address: INJECTIVE_TESTNET_USDC,
      decimals: 6,
    },
    amountAtomic: TEST_USDC_DISPENSER_AMOUNT_ATOMIC,
    amountDisplay: "0.02 test USDC",
    limits: {
      addressWindowHours: 24,
      ipClaimsPerWindow: TEST_USDC_DISPENSER_IP_LIMIT,
      globalClaimsPerWindow: config.dailyClaimLimit,
    },
    disclosure: config.enabled
      ? config.configured
        ? "A dedicated server-side testnet wallet can transfer 0.02 test USDC subject to durable address, IP, and global limits. Configuration is rechecked on every claim."
        : "The dispenser was requested but its dedicated server-side credentials or durable state are incomplete. Claims fail closed."
      : "The judge test-USDC dispenser is disabled and no transfer can be requested.",
  };
}

function normalizedRecipient(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new TestUsdcDispenserError(
      "invalid_recipient",
      400,
      "recipient must be a valid EVM address",
    );
  }
  const recipient = getAddress(value);
  if (recipient === zeroAddress) {
    throw new TestUsdcDispenserError(
      "invalid_recipient",
      400,
      "recipient must not be the zero address",
    );
  }
  return recipient;
}

function normalizedIp(value: string): string {
  const clean = value.trim().toLowerCase();
  return clean && clean.length <= 256 ? clean : "unknown";
}

function retryAfterSeconds(
  retryAt: string | undefined,
  now: Date,
): number | undefined {
  if (!retryAt) return undefined;
  return Math.max(1, Math.ceil((Date.parse(retryAt) - now.getTime()) / 1_000));
}

function throwForClaimLimit(
  decision:
    | Exclude<TestUsdcClaimInspection, { status: "available" }>
    | Exclude<TestUsdcClaimReservation, { status: "started" }>,
  now: Date,
): never {
  const retryAfter = retryAfterSeconds(decision.retryAt, now);
  if (decision.status === "address-limited") {
    throw new TestUsdcDispenserError(
      "address_cooldown",
      429,
      decision.record.status === "confirmed"
        ? "This address has already received test USDC within the last 24 hours."
        : "A previous test-USDC claim for this address is still pending reconciliation.",
      retryAfter,
    );
  }
  if (decision.status === "ip-limited") {
    throw new TestUsdcDispenserError(
      "ip_limit",
      429,
      "This network has reached its five test-USDC claims per 24-hour limit.",
      retryAfter,
    );
  }
  throw new TestUsdcDispenserError(
    "global_limit",
    429,
    "The global 24-hour judge test-USDC budget has been reached.",
    retryAfter,
  );
}

function claimResponse(
  record: TestUsdcClaimRecord,
  explorerUrl: string,
): TestUsdcClaimResponse {
  if (!record.transactionHash || !record.submittedAt) {
    throw new Error("A public test USDC claim response requires a submitted transaction");
  }
  return {
    schema: "proofline.test-usdc-claim.v1",
    status: record.status === "confirmed" ? "confirmed" : "submitted",
    network: INJECTIVE_TESTNET_NETWORK,
    chainId: 1_439,
    asset: {
      symbol: "USDC",
      address: INJECTIVE_TESTNET_USDC,
      decimals: 6,
    },
    recipient: record.recipient,
    amountAtomic: TEST_USDC_DISPENSER_AMOUNT_ATOMIC,
    amountDisplay: "0.02 test USDC",
    transactionHash: record.transactionHash,
    explorerUrl: `${explorerUrl.replace(/\/$/, "")}/tx/${record.transactionHash}`,
    requestedAt: record.requestedAt,
    submittedAt: record.submittedAt,
    ...(record.confirmedAt ? { confirmedAt: record.confirmedAt } : {}),
    nextEligibleAt: new Date(
      Date.parse(record.requestedAt) +
        TEST_USDC_DISPENSER_ADDRESS_WINDOW_MS,
    ).toISOString(),
  };
}

export function createTestUsdcDispenser(
  config: TestUsdcDispenserRuntimeConfig,
  chainClient?: TestUsdcChainClient,
): TestUsdcDispenser {
  if (!config.enabled || !config.configured) {
    return new UnavailableTestUsdcDispenser(config);
  }
  return new RuntimeTestUsdcDispenser(
    config,
    chainClient ?? new ViemTestUsdcChainClient(config),
  );
}
