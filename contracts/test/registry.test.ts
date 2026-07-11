import { readFileSync } from "node:fs";

import solc from "solc";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../src/MatchProofRegistry.sol", import.meta.url),
  "utf8",
);
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "MatchProofRegistry.sol": { content: source } },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        viaIR: true,
        evmVersion: "paris",
        outputSelection: {
          "*": { "*": ["abi", "evm.bytecode.object"] },
        },
      },
    }),
  ),
) as {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<
    string,
    Record<string, { abi: Array<{ type: string; name?: string }>; evm: { bytecode: { object: string } } }>
  >;
};

const compiled = output.contracts?.["MatchProofRegistry.sol"]?.MatchProofRegistry;

describe("MatchProofRegistry artifact", () => {
  it("compiles without Solidity errors and stays deployable", () => {
    const errors = (output.errors ?? []).filter((entry) => entry.severity === "error");
    expect(errors.map((entry) => entry.formattedMessage)).toEqual([]);
    expect(compiled).toBeDefined();
    const creationBytes = (compiled?.evm.bytecode.object.length ?? 0) / 2;
    expect(creationBytes).toBeGreaterThan(0);
    expect(creationBytes).toBeLessThan(24_576);
  });

  it("publishes the safety and revision interfaces used by API and MCP", () => {
    const functions = new Set(
      (compiled?.abi ?? [])
        .filter((entry) => entry.type === "function")
        .map((entry) => entry.name),
    );
    for (const name of [
      "REGISTRY_ID",
      "MIN_VERIFIED_CONFIDENCE_BPS",
      "appendRevision",
      "verifyHistoricalProof",
      "verifyLatestSettlementProof",
      "verifyProof",
      "getDecision",
      "transferOwnership",
      "acceptOwnership",
      "pause",
    ]) {
      expect(functions.has(name), `missing ABI function ${name}`).toBe(true);
    }
    expect(functions.has("anchorProof"), "unsafe convenience writer must stay absent").toBe(false);
  });

  it("keeps the source-level guards that compilation alone cannot infer", () => {
    expect(source).toContain("VerifiedConfidenceTooLow");
    expect(source).toContain("ObservedAtInFuture");
    expect(source).toContain("FinalDecisionImmutable");
    expect(source).toContain("evidenceRoot");
    expect(source).toContain("previousDecisionHash");
  });
});
