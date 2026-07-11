import { readFileSync } from "node:fs";

import solc from "solc";
import type { Abi, Address, EIP1193Provider, Hex } from "viem";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  keccak256,
  stringToHex,
  zeroHash,
} from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { network } from "hardhat";

const source = readFileSync(
  new URL("../src/MatchProofRegistry.sol", import.meta.url),
  "utf8",
);
const compilerOutput = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "MatchProofRegistry.sol": { content: source } },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        viaIR: true,
        evmVersion: "paris",
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
  ),
);
const compilationErrors = (compilerOutput.errors ?? []).filter(
  (entry: { severity: string }) => entry.severity === "error",
);
if (compilationErrors.length > 0) {
  throw new Error(
    compilationErrors.map((entry: { formattedMessage: string }) => entry.formattedMessage).join("\n"),
  );
}
const compiled = compilerOutput.contracts["MatchProofRegistry.sol"].MatchProofRegistry;
const abi = compiled.abi as Abi;
const bytecode = `0x${compiled.evm.bytecode.object}` as Hex;

const testChain = defineChain({
  id: 31_337,
  name: "Hardhat EVM",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://hardhat.local"] } },
});

const State = {
  Provisional: 0,
  Verified: 1,
  Disputed: 2,
  Final: 3,
  Rejected: 4,
} as const;

const hash = (value: string) => keccak256(stringToHex(value));

describe("MatchProofRegistry EVM behavior", () => {
  let connection: Awaited<ReturnType<typeof network.connect>>;
  let provider: EIP1193Provider;
  let publicClient: ReturnType<typeof createPublicClient>;
  let accounts: Address[];
  let registry: Address;

  beforeEach(async () => {
    connection = await network.connect("hardhatMainnet");
    provider = connection.provider as unknown as EIP1193Provider;
    publicClient = createPublicClient({ chain: testChain, transport: custom(provider) });
    accounts = (await provider.request({ method: "eth_accounts" })) as Address[];

    const wallet = createWalletClient({
      account: accounts[0],
      chain: testChain,
      transport: custom(provider),
    });
    const deploymentHash = await wallet.deployContract({
      abi,
      bytecode,
      account: accounts[0],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
    expect(receipt.status).toBe("success");
    if (!receipt.contractAddress) throw new Error("registry deployment returned no address");
    registry = receipt.contractAddress;
  });

  afterEach(async () => {
    await connection.close();
  });

  async function write(
    account: Address,
    functionName: string,
    args: readonly unknown[] = [],
  ) {
    const wallet = createWalletClient({ account, chain: testChain, transport: custom(provider) });
    const transactionHash = await wallet.writeContract({
      address: registry,
      abi,
      functionName,
      args,
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") throw new Error(`${functionName} transaction reverted`);
    return receipt;
  }

  async function read(functionName: string, args: readonly unknown[] = []) {
    return publicClient.readContract({ address: registry, abi, functionName, args });
  }

  async function now() {
    return (await publicClient.getBlock()).timestamp;
  }

  async function expectRevert(action: () => Promise<unknown>, message: string) {
    await expect(action(), message).rejects.toThrow();
  }

  async function append(
    matchIdHash: Hex,
    eventHash: Hex,
    state: number,
    previousDecisionHash: Hex,
    account = accounts[0],
    confidenceBps = state === State.Verified || state === State.Final ? 9_600 : 5_000,
  ) {
    return write(account, "appendRevision", [
      matchIdHash,
      eventHash,
      hash(`evidence:${matchIdHash}:${eventHash}:${state}`),
      confidenceBps,
      await now(),
      state,
      previousDecisionHash,
    ]);
  }

  it("keeps history auditable while only the match-wide latest result can settle", async () => {
    const matchIdHash = hash("match:superseded");
    const oldEvent = hash("event:2-1");
    const correctedEvent = hash("event:2-2");
    const oldEvidence = hash("evidence:old");

    await write(accounts[0], "appendRevision", [
      matchIdHash,
      oldEvent,
      oldEvidence,
      9_650,
      await now(),
      State.Verified,
      zeroHash,
    ]);
    const first = (await read("getLatest", [matchIdHash])) as {
      decisionHash: Hex;
      evidenceRoot: Hex;
    };
    expect(first.evidenceRoot).toBe(oldEvidence);

    await append(matchIdHash, correctedEvent, State.Verified, first.decisionHash);

    const historical = (await read("verifyHistoricalProof", [
      matchIdHash,
      1n,
      oldEvent,
    ])) as readonly unknown[];
    const latestOld = (await read("verifyLatestSettlementProof", [
      matchIdHash,
      oldEvent,
    ])) as readonly unknown[];
    const latestCorrection = (await read("verifyLatestSettlementProof", [
      matchIdHash,
      correctedEvent,
    ])) as readonly unknown[];
    const deprecatedAlias = (await read("verifyProof", [matchIdHash, oldEvent])) as readonly unknown[];

    expect(historical[0]).toBe(true);
    expect(historical[3]).toBe(1n);
    expect(historical[5]).toBe(oldEvidence);
    expect(latestOld[0]).toBe(false);
    expect(latestOld[3]).toBe(2n);
    expect(latestCorrection[0]).toBe(true);
    expect(latestCorrection[3]).toBe(2n);
    expect(deprecatedAlias[0]).toBe(false);
    expect(deprecatedAlias[3]).toBe(2n);
  });

  it("lets Disputed and Rejected latest revisions invalidate older verified results", async () => {
    for (const [suffix, invalidatingState] of [
      ["disputed", State.Disputed],
      ["rejected", State.Rejected],
    ] as const) {
      const matchIdHash = hash(`match:${suffix}`);
      const eventHash = hash(`event:${suffix}`);
      await append(matchIdHash, eventHash, State.Verified, zeroHash);
      const verified = (await read("getLatest", [matchIdHash])) as { decisionHash: Hex };
      await append(matchIdHash, eventHash, invalidatingState, verified.decisionHash);

      const historical = (await read("verifyHistoricalProof", [
        matchIdHash,
        1n,
        eventHash,
      ])) as readonly unknown[];
      const latest = (await read("verifyLatestSettlementProof", [
        matchIdHash,
        eventHash,
      ])) as readonly unknown[];

      expect(historical[0]).toBe(true);
      expect(latest[0]).toBe(false);
      expect(latest[1]).toBe(invalidatingState);
      expect(latest[3]).toBe(2n);
    }
  });

  it("makes Final fully immutable, including a later Final revision", async () => {
    const matchIdHash = hash("match:final");
    const eventHash = hash("event:final");
    await append(matchIdHash, eventHash, State.Verified, zeroHash);
    const verified = (await read("getLatest", [matchIdHash])) as { decisionHash: Hex };
    await append(matchIdHash, eventHash, State.Final, verified.decisionHash);
    const finalDecision = (await read("getLatest", [matchIdHash])) as { decisionHash: Hex };

    for (const rollback of [
      State.Provisional,
      State.Verified,
      State.Disputed,
      State.Rejected,
      State.Final,
    ]) {
      await expectRevert(
        () => append(matchIdHash, eventHash, rollback, finalDecision.decisionHash),
        `Final must not roll back to ${rollback}`,
      );
    }
    expect(await read("getRevisionCount", [matchIdHash])).toBe(2n);

    expect(await read("getRevisionCount", [matchIdHash])).toBe(2n);
  });

  it("enforces optimistic concurrency and leaves revision order unchanged on stale writes", async () => {
    const matchIdHash = hash("match:concurrency");
    const firstEvent = hash("event:first");
    const secondEvent = hash("event:second");
    await append(matchIdHash, firstEvent, State.Verified, zeroHash);
    const first = (await read("getLatest", [matchIdHash])) as { decisionHash: Hex };
    await append(matchIdHash, secondEvent, State.Verified, first.decisionHash);

    await expectRevert(
      () => append(matchIdHash, hash("event:stale-writer"), State.Verified, first.decisionHash),
      "a writer with an old previous hash must lose",
    );
    expect(await read("getRevisionCount", [matchIdHash])).toBe(2n);
    const latest = (await read("getLatest", [matchIdHash])) as {
      eventHash: Hex;
      revision: bigint;
      previousDecisionHash: Hex;
    };
    expect(latest.eventHash).toBe(secondEvent);
    expect(latest.revision).toBe(2n);
    expect(latest.previousDecisionHash).toBe(first.decisionHash);
  });

  it("enforces anchorer and pauser roles and rotates default roles on ownership acceptance", async () => {
    const matchIdHash = hash("match:roles");
    const eventHash = hash("event:roles");

    await expectRevert(
      () => append(matchIdHash, eventHash, State.Verified, zeroHash, accounts[1]),
      "an untrusted account must not anchor",
    );
    await write(accounts[0], "setAnchorer", [accounts[1], true]);
    await append(matchIdHash, eventHash, State.Verified, zeroHash, accounts[1]);

    await write(accounts[0], "setPauser", [accounts[2], true]);
    await write(accounts[2], "pause");
    const first = (await read("getLatest", [matchIdHash])) as { decisionHash: Hex };
    await expectRevert(
      () => append(matchIdHash, eventHash, State.Verified, first.decisionHash, accounts[1]),
      "writes must stop while paused",
    );
    await write(accounts[2], "unpause");

    await write(accounts[0], "transferOwnership", [accounts[3]]);
    await write(accounts[3], "acceptOwnership");
    expect(String(await read("owner")).toLowerCase()).toBe(accounts[3].toLowerCase());
    expect(await read("anchorers", [accounts[0]])).toBe(false);
    expect(await read("pausers", [accounts[0]])).toBe(false);
    expect(await read("anchorers", [accounts[3]])).toBe(true);
    expect(await read("pausers", [accounts[3]])).toBe(true);
    await expectRevert(
      () => write(accounts[0], "setAnchorer", [accounts[4], true]),
      "the previous owner must lose admin authority",
    );
    await write(accounts[3], "setAnchorer", [accounts[4], true]);
    expect(await read("anchorers", [accounts[4]])).toBe(true);
  });

  it("enforces non-empty commitments, confidence, and observation-time guards on-chain", async () => {
    const matchIdHash = hash("match:guards");
    const eventHash = hash("event:guards");
    const observedAt = await now();

    await expectRevert(
      () =>
        write(accounts[0], "appendRevision", [
          matchIdHash,
          eventHash,
          zeroHash,
          9_000,
          observedAt,
          State.Verified,
          zeroHash,
        ]),
      "evidenceRoot must be present",
    );
    await expectRevert(
      () =>
        write(accounts[0], "appendRevision", [
          matchIdHash,
          eventHash,
          hash("evidence"),
          8_199,
          observedAt,
          State.Verified,
          zeroHash,
        ]),
      "Verified confidence must reach the policy threshold",
    );
    await expectRevert(
      () =>
        write(accounts[0], "appendRevision", [
          matchIdHash,
          eventHash,
          hash("evidence"),
          9_000,
          observedAt + 3_600n,
          State.Verified,
          zeroHash,
        ]),
      "observations more than five minutes ahead must fail",
    );
    expect(await read("getRevisionCount", [matchIdHash])).toBe(0n);
  });
});
