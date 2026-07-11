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

export interface AnchorInput {
  matchId: string;
  verification: VerificationResult;
  anchoredAt: string;
}

export interface AnchorService {
  readonly mode: "demo" | "injective-testnet";
  anchor(input: AnchorInput): Promise<AnchorRecord>;
  verify(input: {
    matchId: string;
    eventHash: Hex;
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
    name: "anchorProof",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchIdHash", type: "bytes32" },
      { name: "eventHash", type: "bytes32" },
      { name: "confidenceBps", type: "uint16" },
      { name: "observedAt", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "verifyProof",
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
    ],
  },
] as const;

const EXPECTED_REGISTRY_ID = keccak256(
  stringToHex("proofline.match-proof-registry.v1"),
);

export class DemoAnchorService implements AnchorService {
  readonly mode = "demo" as const;

  async anchor(input: AnchorInput): Promise<AnchorRecord> {
    const txHash = keccak256(
      stringToHex(
        `proofline.demo.anchor.v1:${input.matchId}:${input.verification.canonical.eventHash}:${input.verification.confidenceBps}:${input.anchoredAt}`,
      ),
    );

    return {
      receipt: {
        mode: "demo",
        eventHash: input.verification.canonical.eventHash,
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
      throw new Error("The configured contract is not a Proofline MatchProofRegistry v1 instance.");
    }
    if (!isAnchorer) {
      throw new Error("The configured API signer does not have the registry anchorer role.");
    }
    if (gasBalance === 0n) {
      throw new Error("The configured API signer has no test INJ for anchor gas.");
    }

    const txHash = await wallet.writeContract({
      account,
      address: this.config.registryAddress,
      abi: registryAbi,
      functionName: "anchorProof",
      args: [
        matchIdHash,
        input.verification.canonical.eventHash,
        input.verification.confidenceBps,
        observedAt,
      ],
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`Injective anchor transaction ${txHash} reverted.`);
    }
    const anchoredBlock = await publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    const chainAnchoredAt = new Date(
      Number(anchoredBlock.timestamp) * 1_000,
    ).toISOString();
    const [valid, state, anchoredConfidenceBps] = await publicClient.readContract({
      address: this.config.registryAddress,
      abi: registryAbi,
      functionName: "verifyProof",
      args: [matchIdHash, input.verification.canonical.eventHash],
      blockNumber: receipt.blockNumber,
    });
    if (
      !valid ||
      state !== 1 ||
      anchoredConfidenceBps !== input.verification.confidenceBps
    ) {
      throw new Error(
        `Anchor transaction ${txHash} succeeded but the registry postcondition did not match the submitted proof.`,
      );
    }

    return {
      receipt: {
        mode: "injective-testnet",
        eventHash: input.verification.canonical.eventHash,
        confidenceBps: input.verification.confidenceBps,
        // A real receipt is timed from the canonical chain block, never from
        // the replay clock or the API host clock.
        anchoredAt: chainAnchoredAt,
        confirmed: true,
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        contractAddress: this.config.registryAddress,
        explorerUrl: `${this.config.explorerUrl.replace(/\/$/, "")}/tx/${txHash}`,
      },
      simulated: false,
      disclosure:
        "Injective EVM testnet receipt. The transaction proves commitment of the event hash, not the sporting fact by itself.",
    };
  }

  async verify(input: {
    matchId: string;
    eventHash: Hex;
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
    const [code, registryId, latest, receipt, transaction, checkedAtBlock] =
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
          functionName: "verifyProof",
          args: [matchIdHash, input.eventHash],
        }),
        client.getTransactionReceipt({ hash: input.txHash }),
        client.getTransaction({ hash: input.txHash }),
        client.getBlockNumber(),
      ]);
    if (!code || code === "0x" || registryId !== EXPECTED_REGISTRY_ID) {
      return {
        checked: true,
        valid: false,
        mode: "injective-testnet",
        reason: "Configured address is not a Proofline MatchProofRegistry v1.",
      };
    }
    const receiptBlock = await client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    const chainAnchoredAt = new Date(
      Number(receiptBlock.timestamp) * 1_000,
    ).toISOString();

    let callMatches = false;
    try {
      const decoded = decodeFunctionData({
        abi: registryAbi,
        data: transaction.input,
      });
      if (decoded.functionName === "anchorProof") {
        const [
          txMatchIdHash,
          txEventHash,
          txConfidenceBps,
          txObservedAt,
        ] = decoded.args;
        callMatches =
          txMatchIdHash === matchIdHash &&
          txEventHash === input.eventHash &&
          txConfidenceBps === input.verificationConfidenceBps &&
          txObservedAt === expectedObservedAt;
      }
    } catch {
      callMatches = false;
    }

    const [latestValid, latestState, latestConfidenceBps, revision, decisionHash] =
      latest;
    const receiptMatches =
      receipt.status === "success" &&
      receipt.to?.toLowerCase() === this.config.registryAddress.toLowerCase() &&
      transaction.to?.toLowerCase() === this.config.registryAddress.toLowerCase();
    const receiptClaimsMatch =
      input.anchorConfidenceBps === input.verificationConfidenceBps &&
      input.blockNumber === receipt.blockNumber.toString() &&
      input.anchoredAt === chainAnchoredAt &&
      input.explorerUrl === expectedExplorerUrl;
    const valid =
      latestValid &&
      (latestState === 1 || latestState === 3) &&
      latestConfidenceBps === input.verificationConfidenceBps &&
      receiptMatches &&
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
      latest: {
        state: latestState,
        confidenceBps: latestConfidenceBps,
        revision: revision.toString(),
        decisionHash,
      },
      checks: {
        registryIdentity: true,
        latestEventHash: latestValid,
        confidence:
          latestConfidenceBps === input.verificationConfidenceBps &&
          input.anchorConfidenceBps === input.verificationConfidenceBps,
        observedAt: callMatches,
        blockNumber: input.blockNumber === receipt.blockNumber.toString(),
        anchoredAt: input.anchoredAt === chainAnchoredAt,
        explorerUrl: input.explorerUrl === expectedExplorerUrl,
        transactionTarget: receiptMatches,
        transactionCalldata: callMatches,
      },
      reason: valid
        ? "Fresh Injective testnet registry state and the claimed anchor transaction both match this packet."
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
