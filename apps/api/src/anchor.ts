import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { VerificationResult } from "@proofline/core";
import type { AnchorRecord } from "./api-types.js";
import {
  INJECTIVE_TESTNET_CHAIN_ID,
  INJECTIVE_TESTNET_EXPLORER_URL,
  INJECTIVE_TESTNET_NETWORK,
  INJECTIVE_TESTNET_RPC_URL,
  type AnchorRuntimeConfig,
} from "./config.js";

interface ExplorerTransaction {
  hash: Hex;
  status: string;
  result: string;
  revertReason: string | null;
  blockNumber: bigint;
  timestamp: string;
  from: Address;
  to: Address;
  input: Hex;
}

export async function explorerTransaction(
  baseUrl: string,
  txHash: Hex,
): Promise<ExplorerTransaction | null> {
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/v2/transactions/${txHash}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const from = body.from as { hash?: unknown } | undefined;
    const to = body.to as { hash?: unknown } | undefined;
    if (
      typeof body.hash !== "string" ||
      body.hash.toLowerCase() !== txHash.toLowerCase() ||
      typeof body.status !== "string" ||
      body.status.toLowerCase() !== "ok" ||
      typeof body.result !== "string" ||
      body.result.toLowerCase() !== "success" ||
      body.revert_reason !== null ||
      typeof body.block_number !== "number" ||
      !Number.isSafeInteger(body.block_number) ||
      body.block_number <= 0 ||
      typeof body.timestamp !== "string" ||
      !Number.isFinite(new Date(body.timestamp).getTime()) ||
      typeof from?.hash !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(from.hash) ||
      typeof to?.hash !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(to.hash) ||
      typeof body.raw_input !== "string" ||
      !/^0x[0-9a-fA-F]*$/.test(body.raw_input)
    ) {
      return null;
    }
    return {
      hash: body.hash as Hex,
      status: body.status,
      result: body.result,
      revertReason: body.revert_reason as string | null,
      blockNumber: BigInt(body.block_number),
      timestamp: body.timestamp,
      from: from.hash as Address,
      to: to.hash as Address,
      input: body.raw_input as Hex,
    };
  } catch {
    return null;
  }
}

function blockContainsTransaction(
  transactions: readonly (Hex | { hash: Hex })[],
  txHash: Hex,
): boolean {
  return transactions.some((transaction) =>
    (typeof transaction === "string" ? transaction : transaction.hash)
      .toLowerCase()
      === txHash.toLowerCase(),
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface AnchorInput {
  matchId: string;
  verification: VerificationResult;
  evidenceRoot: Hex;
  anchoredAt: string;
}

export interface AnchorService {
  readonly mode: "demo" | "injective-testnet";
  anchor(input: AnchorInput): Promise<AnchorRecord>;
  verify(input: {
    matchId: string;
    eventHash: Hex;
    evidenceRoot: Hex;
    verificationConfidenceBps: number;
    anchorConfidenceBps: number;
    observedAt: string;
    anchoredAt: string;
    txHash?: Hex;
    contractAddress?: Address;
    blockNumber?: string;
    explorerUrl?: string;
  }): Promise<Record<string, unknown>>;
  status(): Record<string, unknown>;
}

const registryAbi = [
  {
    type: "function",
    name: "REGISTRY_ID",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "anchorers",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getRevisionCount",
    stateMutability: "view",
    inputs: [{ name: "matchIdHash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "getLatest",
    stateMutability: "view",
    inputs: [{ name: "matchIdHash", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "matchIdHash", type: "bytes32" },
          { name: "eventHash", type: "bytes32" },
          { name: "evidenceRoot", type: "bytes32" },
          { name: "previousDecisionHash", type: "bytes32" },
          { name: "decisionHash", type: "bytes32" },
          { name: "revision", type: "uint64" },
          { name: "observedAt", type: "uint64" },
          { name: "anchoredAt", type: "uint64" },
          { name: "confidenceBps", type: "uint16" },
          { name: "state", type: "uint8" },
          { name: "anchoredBy", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "appendRevision",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchIdHash", type: "bytes32" },
      { name: "eventHash", type: "bytes32" },
      { name: "evidenceRoot", type: "bytes32" },
      { name: "confidenceBps", type: "uint16" },
      { name: "observedAt", type: "uint64" },
      { name: "state", type: "uint8" },
      { name: "expectedPreviousDecisionHash", type: "bytes32" },
    ],
    outputs: [
      { name: "revision", type: "uint64" },
      { name: "decisionHash", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "verifyLatestSettlementProof",
    stateMutability: "view",
    inputs: [
      { name: "matchIdHash", type: "bytes32" },
      { name: "eventHash", type: "bytes32" },
    ],
    outputs: [
      { name: "valid", type: "bool" },
      { name: "state", type: "uint8" },
      { name: "confidenceBps", type: "uint16" },
      { name: "revision", type: "uint64" },
      { name: "decisionHash", type: "bytes32" },
      { name: "evidenceRoot", type: "bytes32" },
    ],
  },
] as const;

const EXPECTED_REGISTRY_ID = keccak256(
  stringToHex("proofline.match-proof-registry.v2"),
);

export class DemoAnchorService implements AnchorService {
  readonly mode = "demo" as const;

  async anchor(input: AnchorInput): Promise<AnchorRecord> {
    const txHash = keccak256(
      stringToHex(
        `proofline.demo.anchor.v2:${input.matchId}:${input.verification.canonical.eventHash}:${input.evidenceRoot}:${input.verification.confidenceBps}:${input.anchoredAt}`,
      ),
    );

    return {
      receipt: {
        mode: "demo",
        eventHash: input.verification.canonical.eventHash,
        evidenceRoot: input.evidenceRoot,
        confidenceBps: input.verification.confidenceBps,
        anchoredAt: input.anchoredAt,
        confirmed: true,
        txHash,
        blockNumber: "demo-replay",
      },
      simulated: true,
      disclosure:
        "DEMO RECEIPT · deterministic local simulation · no blockchain transaction or gas spend occurred.",
    };
  }

  async verify(): Promise<Record<string, unknown>> {
    return {
      checked: false,
      valid: false,
      mode: "demo",
      reason:
        "Demo receipts have no registry transaction. Only packet/hash consistency can be recomputed.",
    };
  }

  status(): Record<string, unknown> {
    return {
      mode: "demo",
      status: "ready",
      simulated: true,
      chainId: INJECTIVE_TESTNET_CHAIN_ID,
      network: INJECTIVE_TESTNET_NETWORK,
      publicRpcUrl: INJECTIVE_TESTNET_RPC_URL,
      registryAddress: null,
      explorerUrl: INJECTIVE_TESTNET_EXPLORER_URL,
      disclosure:
        "Deterministic demo receipts are enabled. They are not Injective transactions and have no explorer URL.",
    };
  }
}

export class InjectiveAnchorService implements AnchorService {
  readonly mode = "injective-testnet" as const;

  constructor(private readonly config: Extract<AnchorRuntimeConfig, { mode: "injective-testnet" }>) {}

  async anchor(input: AnchorInput): Promise<AnchorRecord> {
    const chain = defineChain({
      id: this.config.chainId,
      name: "Injective EVM Testnet",
      nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
      rpcUrls: { default: { http: [this.config.rpcUrl] } },
      blockExplorers: {
        default: { name: "Injective Testnet Blockscout", url: this.config.explorerUrl },
      },
      testnet: true,
    });
    const account = privateKeyToAccount(this.config.privateKey);
    const wallet = createWalletClient({ account, chain, transport: http(this.config.rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(this.config.rpcUrl) });
    const observedAt = BigInt(
      Math.floor(new Date(input.verification.canonical.occurredAt).getTime() / 1_000),
    );
    const matchIdHash = keccak256(
      stringToHex(input.matchId.trim().toUpperCase()),
    );

    const actualChainId = await publicClient.getChainId();
    if (actualChainId !== INJECTIVE_TESTNET_CHAIN_ID) {
      throw new Error(
        `Injective anchor RPC returned chain ID ${actualChainId}; expected ${INJECTIVE_TESTNET_CHAIN_ID}.`,
      );
    }
    const [registryCode, registryId, isAnchorer, gasBalance] = await Promise.all([
      publicClient.getCode({ address: this.config.registryAddress }),
      publicClient.readContract({
        address: this.config.registryAddress,
        abi: registryAbi,
        functionName: "REGISTRY_ID",
      }),
      publicClient.readContract({
        address: this.config.registryAddress,
        abi: registryAbi,
        functionName: "anchorers",
        args: [account.address],
      }),
      publicClient.getBalance({ address: account.address }),
    ]);
    if (!registryCode || registryCode === "0x") {
      throw new Error("No MatchProofRegistry code exists at the configured address.");
    }
    if (registryId !== EXPECTED_REGISTRY_ID) {
      throw new Error("The configured contract is not a Proofline MatchProofRegistry v2 instance.");
    }
    if (!isAnchorer) {
      throw new Error("The configured API signer does not have the registry anchorer role.");
    }
    if (gasBalance === 0n) {
      throw new Error("The configured API signer has no test INJ for anchor gas.");
    }

    const latestMatches = (latest: {
      eventHash: Hex;
      evidenceRoot: Hex;
      confidenceBps: number;
      state: number;
      anchoredAt: bigint;
      revision: bigint;
      decisionHash: Hex;
    }): boolean =>
      latest.eventHash === input.verification.canonical.eventHash &&
      latest.evidenceRoot === input.evidenceRoot &&
      latest.confidenceBps === input.verification.confidenceBps &&
      (latest.state === 1 || latest.state === 3);
    const idempotentRecord = async (latest: {
      anchoredAt: bigint;
      revision: bigint;
      previousDecisionHash: Hex;
    }): Promise<AnchorRecord> => {
      let indexed: ExplorerTransaction | null = null;
      try {
        const response = await fetch(
          `${this.config.explorerApiUrl.replace(/\/$/, "")}/v2/addresses/${this.config.registryAddress}/transactions?filter=to`,
          {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(5_000),
          },
        );
        if (response.ok) {
          const page = (await response.json()) as { items?: unknown };
          if (Array.isArray(page.items)) {
            for (const item of page.items.slice(0, 50)) {
              if (!item || typeof item !== "object") continue;
              const candidate = item as Record<string, unknown>;
              const candidateTo = candidate.to as { hash?: unknown } | null;
              if (
                typeof candidate.hash !== "string" ||
                !/^0x[0-9a-fA-F]{64}$/.test(candidate.hash) ||
                candidate.status !== "ok" ||
                candidate.result !== "success" ||
                candidate.revert_reason !== null ||
                typeof candidate.block_number !== "number" ||
                !Number.isSafeInteger(candidate.block_number) ||
                typeof candidate.timestamp !== "string" ||
                Math.floor(new Date(candidate.timestamp).getTime() / 1_000) !==
                  Number(latest.anchoredAt) ||
                typeof candidateTo?.hash !== "string" ||
                candidateTo.hash.toLowerCase() !==
                  this.config.registryAddress.toLowerCase() ||
                typeof candidate.raw_input !== "string" ||
                !/^0x[0-9a-fA-F]+$/.test(candidate.raw_input)
              ) {
                continue;
              }
              try {
                const decoded = decodeFunctionData({
                  abi: registryAbi,
                  data: candidate.raw_input as Hex,
                });
                if (decoded.functionName !== "appendRevision") continue;
                const [
                  txMatchIdHash,
                  txEventHash,
                  txEvidenceRoot,
                  txConfidenceBps,
                  txObservedAt,
                  txState,
                  txPreviousDecisionHash,
                ] = decoded.args;
                if (
                  txMatchIdHash !== matchIdHash ||
                  txEventHash !== input.verification.canonical.eventHash ||
                  txEvidenceRoot !== input.evidenceRoot ||
                  txConfidenceBps !== input.verification.confidenceBps ||
                  txObservedAt !== observedAt ||
                  (txState !== 1 && txState !== 3) ||
                  txPreviousDecisionHash !== latest.previousDecisionHash
                ) {
                  continue;
                }
                const block = await publicClient.getBlock({
                  blockNumber: BigInt(candidate.block_number),
                  includeTransactions: true,
                });
                if (
                  !blockContainsTransaction(
                    block.transactions,
                    candidate.hash as Hex,
                  )
                ) {
                  continue;
                }
                indexed = {
                  hash: candidate.hash as Hex,
                  status: "ok",
                  result: "success",
                  revertReason: null,
                  blockNumber: BigInt(candidate.block_number),
                  timestamp: candidate.timestamp,
                  from: account.address,
                  to: candidateTo.hash as Address,
                  input: candidate.raw_input as Hex,
                };
                break;
              } catch {
                continue;
              }
            }
          }
        }
      } catch {
        indexed = null;
      }
      return {
        receipt: {
        mode: "injective-testnet",
        eventHash: input.verification.canonical.eventHash,
        evidenceRoot: input.evidenceRoot,
        confidenceBps: input.verification.confidenceBps,
        anchoredAt: new Date(Number(latest.anchoredAt) * 1_000).toISOString(),
        confirmed: true,
        contractAddress: this.config.registryAddress,
          ...(indexed
            ? {
                txHash: indexed.hash,
                blockNumber: indexed.blockNumber.toString(),
                explorerUrl: `${this.config.explorerUrl.replace(/\/$/, "")}/tx/${indexed.hash}`,
                receiptIndexing: "explorer-api-and-rpc-state" as const,
              }
            : {
                receiptIndexing: "state-only-idempotent" as const,
                transactionLinkUnavailable: true,
              }),
        },
        simulated: false,
        disclosure: indexed
          ? "Injective EVM testnet commitment already existed as the match-wide latest revision; its original canonical transaction was recovered from the official Explorer API."
          : "Injective EVM testnet commitment already existed as the match-wide latest revision; no duplicate transaction was sent, but the original transaction link was unavailable in the bounded Explorer lookup.",
      };
    };

    const revisionCount = await publicClient.readContract({
      address: this.config.registryAddress,
      abi: registryAbi,
      functionName: "getRevisionCount",
      args: [matchIdHash],
    });
    const latestBefore =
      revisionCount > 0n
        ? await publicClient.readContract({
            address: this.config.registryAddress,
            abi: registryAbi,
            functionName: "getLatest",
            args: [matchIdHash],
          })
        : undefined;
    if (latestBefore && latestMatches(latestBefore)) {
      return idempotentRecord(latestBefore);
    }
    const expectedPreviousDecisionHash =
      latestBefore?.decisionHash ?? (`0x${"0".repeat(64)}` as Hex);
    let simulated;
    try {
      simulated = await publicClient.simulateContract({
        account,
        address: this.config.registryAddress,
        abi: registryAbi,
        functionName: "appendRevision",
        args: [
          matchIdHash,
          input.verification.canonical.eventHash,
          input.evidenceRoot,
          input.verification.confidenceBps,
          observedAt,
          1,
          expectedPreviousDecisionHash,
        ],
      });
    } catch {
      const latestAfterSimulationConflict = await publicClient.readContract({
        address: this.config.registryAddress,
        abi: registryAbi,
        functionName: "getLatest",
        args: [matchIdHash],
      });
      if (latestMatches(latestAfterSimulationConflict)) {
        return idempotentRecord(latestAfterSimulationConflict);
      }
      throw new Error(
        "The match decision changed concurrently; retry after reading the latest revision.",
      );
    }
    const txHash = await wallet.writeContract(simulated.request);
    const confirmationDeadline = Date.now() + 45_000;
    let receiptBlockNumber: bigint | undefined;
    try {
      const indexedReceipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 8_000,
        pollingInterval: 1_000,
      });
      if (indexedReceipt.status === "reverted") {
        throw new Error("anchor-transaction-reverted");
      }
      receiptBlockNumber = indexedReceipt.blockNumber;
    } catch {
      // Injective can expose canonical block/state before its EVM receipt
      // index. The bounded Explorer+RPC fallback below is the authority path.
    }

    let canonicalBlock:
      | Awaited<ReturnType<typeof publicClient.getBlock>>
      | undefined;
    let explorerTx: ExplorerTransaction | null = null;
    let latestAfter:
      | readonly [boolean, number, number, bigint, Hex, Hex]
      | undefined;
    while (Date.now() < confirmationDeadline) {
      [explorerTx, latestAfter] = await Promise.all([
        explorerTransaction(this.config.explorerApiUrl, txHash),
        publicClient.readContract({
          address: this.config.registryAddress,
          abi: registryAbi,
          functionName: "verifyLatestSettlementProof",
          args: [matchIdHash, input.verification.canonical.eventHash],
        }),
      ]);
      const [valid, state, anchoredConfidenceBps, , , anchoredEvidenceRoot] =
        latestAfter;
      if (
        explorerTx &&
        explorerTx.status.toLowerCase() === "ok" &&
        explorerTx.result.toLowerCase() === "success" &&
        explorerTx.revertReason === null &&
        explorerTx.to.toLowerCase() ===
          this.config.registryAddress.toLowerCase() &&
        valid &&
        state === 1 &&
        anchoredConfidenceBps === input.verification.confidenceBps &&
        anchoredEvidenceRoot === input.evidenceRoot
      ) {
        let callMatches = false;
        try {
          const decoded = decodeFunctionData({
            abi: registryAbi,
            data: explorerTx.input,
          });
          if (decoded.functionName === "appendRevision") {
            const [
              txMatchIdHash,
              txEventHash,
              txEvidenceRoot,
              txConfidenceBps,
              txObservedAt,
              txState,
              txPreviousDecisionHash,
            ] = decoded.args;
            callMatches =
              txMatchIdHash === matchIdHash &&
              txEventHash === input.verification.canonical.eventHash &&
              txEvidenceRoot === input.evidenceRoot &&
              txConfidenceBps === input.verification.confidenceBps &&
              txObservedAt === observedAt &&
              txState === 1 &&
              txPreviousDecisionHash === expectedPreviousDecisionHash;
          }
        } catch {
          callMatches = false;
        }
        if (callMatches) {
          const block = await publicClient.getBlock({
            blockNumber: explorerTx.blockNumber,
            includeTransactions: true,
          });
          if (blockContainsTransaction(block.transactions, txHash)) {
            canonicalBlock = block;
            break;
          }
        }
      }
      await wait(1_000);
    }

    if (!canonicalBlock || !explorerTx || !latestAfter) {
      const latestAfterConflict = await publicClient.readContract({
        address: this.config.registryAddress,
        abi: registryAbi,
        functionName: "verifyLatestSettlementProof",
        args: [matchIdHash, input.verification.canonical.eventHash],
      });
      if (
        latestAfterConflict[0] &&
        latestAfterConflict[5] === input.evidenceRoot
      ) {
        throw new Error(
          `Anchor ${txHash} reached registry state, but its canonical transaction block was not indexed within 45 seconds.`,
        );
      }
      throw new Error(
        "The match decision changed concurrently; the API refused to overwrite the newer revision.",
      );
    }
    const chainAnchoredAt = new Date(
      Number(canonicalBlock.timestamp) * 1_000,
    ).toISOString();
    const [valid, state, anchoredConfidenceBps, , , anchoredEvidenceRoot] =
      latestAfter;
    if (
      !valid ||
      state !== 1 ||
      anchoredConfidenceBps !== input.verification.confidenceBps ||
      anchoredEvidenceRoot !== input.evidenceRoot
    ) {
      throw new Error(
        `Anchor transaction ${txHash} succeeded but the registry postcondition did not match the submitted proof.`,
      );
    }

    return {
      receipt: {
        mode: "injective-testnet",
        eventHash: input.verification.canonical.eventHash,
        evidenceRoot: input.evidenceRoot,
        confidenceBps: input.verification.confidenceBps,
        // A real receipt is timed from the canonical chain block, never from
        // the replay clock or the API host clock.
        anchoredAt: chainAnchoredAt,
        confirmed: true,
        txHash,
        blockNumber: explorerTx.blockNumber.toString(),
        contractAddress: this.config.registryAddress,
        explorerUrl: `${this.config.explorerUrl.replace(/\/$/, "")}/tx/${txHash}`,
        receiptIndexing:
          receiptBlockNumber === explorerTx.blockNumber
            ? "eth_getTransactionReceipt"
            : "explorer-api-and-rpc-state",
      },
      simulated: false,
      disclosure:
        "Injective EVM testnet commitment confirmed by latest registry state plus the canonical RPC block and official Explorer transaction API. The chain proves commitment, not the sporting fact by itself.",
    };
  }

  async verify(input: {
    matchId: string;
    eventHash: Hex;
    evidenceRoot: Hex;
    verificationConfidenceBps: number;
    anchorConfidenceBps: number;
    observedAt: string;
    anchoredAt: string;
    txHash?: Hex;
    contractAddress?: Address;
    blockNumber?: string;
    explorerUrl?: string;
  }): Promise<Record<string, unknown>> {
    if (
      !input.txHash ||
      !/^0x[0-9a-fA-F]{64}$/.test(input.txHash) ||
      !input.contractAddress ||
      input.contractAddress.toLowerCase() !==
        this.config.registryAddress.toLowerCase()
    ) {
      return {
        checked: true,
        valid: false,
        mode: "injective-testnet",
        reason:
          "The packet does not name the configured registry and a valid anchor transaction.",
      };
    }

    const chain = defineChain({
      id: INJECTIVE_TESTNET_CHAIN_ID,
      name: "Injective EVM Testnet",
      nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
      rpcUrls: { default: { http: [this.config.rpcUrl] } },
      blockExplorers: {
        default: {
          name: "Injective Testnet Blockscout",
          url: this.config.explorerUrl,
        },
      },
      testnet: true,
    });
    const client = createPublicClient({
      chain,
      transport: http(this.config.rpcUrl),
    });
    const actualChainId = await client.getChainId();
    if (actualChainId !== INJECTIVE_TESTNET_CHAIN_ID) {
      throw new Error(
        `Registry verification RPC returned chain ID ${actualChainId}; expected ${INJECTIVE_TESTNET_CHAIN_ID}.`,
      );
    }
    const matchIdHash = keccak256(
      stringToHex(input.matchId.trim().toUpperCase()),
    );
    const expectedObservedAt = BigInt(
      Math.floor(new Date(input.observedAt).getTime() / 1_000),
    );
    const expectedExplorerUrl = `${this.config.explorerUrl.replace(/\/$/, "")}/tx/${input.txHash}`;
    const indexedTransaction = await explorerTransaction(
      this.config.explorerApiUrl,
      input.txHash,
    );
    if (!indexedTransaction) {
      return {
        checked: false,
        valid: false,
        mode: "injective-testnet",
        reason:
          "The official Injective Explorer API has not indexed the claimed transaction yet; no on-chain validity claim was made.",
      };
    }
    const [code, registryId, latest, canonicalBlock, checkedAtBlock] =
      await Promise.all([
        client.getCode({ address: this.config.registryAddress }),
        client.readContract({
          address: this.config.registryAddress,
          abi: registryAbi,
          functionName: "REGISTRY_ID",
        }),
        client.readContract({
          address: this.config.registryAddress,
          abi: registryAbi,
          functionName: "verifyLatestSettlementProof",
          args: [matchIdHash, input.eventHash],
        }),
        client.getBlock({
          blockNumber: indexedTransaction.blockNumber,
          includeTransactions: true,
        }),
        client.getBlockNumber(),
      ]);
    if (!code || code === "0x" || registryId !== EXPECTED_REGISTRY_ID) {
      return {
        checked: true,
        valid: false,
        mode: "injective-testnet",
        reason: "Configured address is not a Proofline MatchProofRegistry v2.",
      };
    }
    const chainAnchoredAt = new Date(
      Number(canonicalBlock.timestamp) * 1_000,
    ).toISOString();

    let callMatches = false;
    try {
      const decoded = decodeFunctionData({
        abi: registryAbi,
        data: indexedTransaction.input,
      });
      if (decoded.functionName === "appendRevision") {
        const [
          txMatchIdHash,
          txEventHash,
          txEvidenceRoot,
          txConfidenceBps,
          txObservedAt,
          txState,
        ] = decoded.args;
        callMatches =
          txMatchIdHash === matchIdHash &&
          txEventHash === input.eventHash &&
          txEvidenceRoot === input.evidenceRoot &&
          txConfidenceBps === input.verificationConfidenceBps &&
          txObservedAt === expectedObservedAt &&
          txState === 1;
      }
    } catch {
      callMatches = false;
    }

    const [latestValid, latestState, latestConfidenceBps, revision, decisionHash, latestEvidenceRoot] =
      latest;
    const transactionInCanonicalBlock = blockContainsTransaction(
      canonicalBlock.transactions,
      input.txHash,
    );
    const transactionMatches =
      indexedTransaction.status.toLowerCase() === "ok" &&
      indexedTransaction.result.toLowerCase() === "success" &&
      indexedTransaction.revertReason === null &&
      indexedTransaction.to.toLowerCase() ===
        this.config.registryAddress.toLowerCase() &&
      transactionInCanonicalBlock;
    const receiptClaimsMatch =
      input.anchorConfidenceBps === input.verificationConfidenceBps &&
      input.blockNumber === indexedTransaction.blockNumber.toString() &&
      input.anchoredAt === chainAnchoredAt &&
      input.explorerUrl === expectedExplorerUrl;
    const valid =
      latestValid &&
      (latestState === 1 || latestState === 3) &&
      latestConfidenceBps === input.verificationConfidenceBps &&
      latestEvidenceRoot === input.evidenceRoot &&
      transactionMatches &&
      callMatches &&
      receiptClaimsMatch;

    return {
      checked: true,
      valid,
      mode: "injective-testnet",
      chainId: actualChainId,
      registryAddress: this.config.registryAddress,
      transactionHash: input.txHash,
      checkedAtBlock: checkedAtBlock.toString(),
      receiptIndexing: "explorer-api-and-rpc-state",
      latest: {
        state: latestState,
        confidenceBps: latestConfidenceBps,
        revision: revision.toString(),
        decisionHash,
        evidenceRoot: latestEvidenceRoot,
      },
      checks: {
        registryIdentity: true,
        latestEventHash: latestValid,
        evidenceRoot: latestEvidenceRoot === input.evidenceRoot,
        confidence:
          latestConfidenceBps === input.verificationConfidenceBps &&
          input.anchorConfidenceBps === input.verificationConfidenceBps,
        observedAt: callMatches,
        blockNumber:
          input.blockNumber === indexedTransaction.blockNumber.toString(),
        anchoredAt: input.anchoredAt === chainAnchoredAt,
        explorerUrl: input.explorerUrl === expectedExplorerUrl,
        transactionTarget:
          indexedTransaction.to.toLowerCase() ===
          this.config.registryAddress.toLowerCase(),
        transactionStatus: indexedTransaction.status.toLowerCase() === "ok",
        transactionResult:
          indexedTransaction.result.toLowerCase() === "success" &&
          indexedTransaction.revertReason === null,
        transactionInCanonicalBlock,
        transactionCalldata: callMatches,
      },
      reason: valid
        ? "Fresh latest registry state, official Explorer transaction data, and the canonical RPC block all match this packet."
        : "The latest registry state or claimed anchor transaction does not match this packet.",
    };
  }

  status(): Record<string, unknown> {
    return {
      mode: "injective-testnet",
      status: "configured-unverified",
      simulated: false,
      connectivityChecked: false,
      chainId: this.config.chainId,
      network: `eip155:${this.config.chainId}`,
      // Never return the server-side RPC: it can contain a billable provider
      // credential. Browser and MCP reads use the fixed public testnet endpoint.
      publicRpcUrl: INJECTIVE_TESTNET_RPC_URL,
      registryAddress: this.config.registryAddress,
      explorerUrl: this.config.explorerUrl,
      explorerApiUrl: this.config.explorerApiUrl,
      disclosure:
        "Real Injective EVM testnet anchoring is configured. Chain ID, registry code, anchorer role, gas balance, and transaction success are checked when an anchor is attempted.",
    };
  }
}

export function createAnchorService(config: AnchorRuntimeConfig): AnchorService {
  return config.mode === "injective-testnet"
    ? new InjectiveAnchorService(config)
    : new DemoAnchorService();
}
