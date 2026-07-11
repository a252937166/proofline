import { describe, expect, it } from "vitest";

import {
  PROOFLINE_REGISTRY_ID,
  PROOFLINE_REGISTRY_ID_TEXT,
  TESTNET_WRITE_ACK,
  assertMatchingEvidenceRoot,
  assertAllowedApiOrigin,
  isBytes32,
  prooflineSessionId,
  updateEnvText,
  writeIsAuthorized,
} from "../lib/testnet-workflow.js";
import { keccak256, stringToHex } from "viem";

describe("testnet workflow safety", () => {
  it("updates the registry address without exposing or changing secrets", () => {
    const secret = `0x${"ab".repeat(32)}`;
    const updated = updateEnvText(
      `CHAIN_MODE=demo\nANCHOR_PRIVATE_KEY=${secret}\nPROOF_REGISTRY_ADDRESS=\n`,
      {
        PROOF_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
      },
    );

    expect(updated).toContain(`ANCHOR_PRIVATE_KEY=${secret}`);
    expect(updated).toContain(
      "PROOF_REGISTRY_ADDRESS=0x1111111111111111111111111111111111111111",
    );
    expect(updated.match(/^PROOF_REGISTRY_ADDRESS=/gm)).toHaveLength(1);
    expect(updated).toContain("CHAIN_MODE=demo");
  });

  it("requires both the action flag and the action-specific acknowledgement", () => {
    expect(
      writeIsAuthorized("anchor", ["--broadcast"], {
        PROOFLINE_TESTNET_WRITE_ACK: TESTNET_WRITE_ACK.anchor,
      }),
    ).toBe(true);
    expect(
      writeIsAuthorized("anchor", ["--broadcast"], {
        PROOFLINE_TESTNET_WRITE_ACK: TESTNET_WRITE_ACK.payment,
      }),
    ).toBe(false);
    expect(
      writeIsAuthorized("payment", [], {
        PROOFLINE_TESTNET_WRITE_ACK: TESTNET_WRITE_ACK.payment,
      }),
    ).toBe(false);
  });

  it("pins the shared judge session and rejects unsafe API origins", () => {
    expect(prooflineSessionId()).toBe("proofline-testnet-judge");
    expect(() => prooflineSessionId("short")).toThrow("8-64");
    expect(() =>
      assertAllowedApiOrigin(
        new URL("http://api.example/proof"),
        "http://api.example",
      ),
    ).toThrow("HTTPS");
    expect(() =>
      assertAllowedApiOrigin(
        new URL("https://evil.example/proof"),
        "https://api.example",
      ),
    ).toThrow("allowed origin");
    expect(() =>
      assertAllowedApiOrigin(
        new URL("http://127.0.0.1:8787/api/proof"),
      ),
    ).not.toThrow();
  });

  it("pins Registry v2 and validates the evidence commitment read back from chain", () => {
    expect(PROOFLINE_REGISTRY_ID_TEXT).toBe(
      "proofline.match-proof-registry.v2",
    );
    expect(PROOFLINE_REGISTRY_ID).toBe(
      keccak256(stringToHex(PROOFLINE_REGISTRY_ID_TEXT)),
    );

    const root = `0x${"12".repeat(32)}`;
    expect(isBytes32(root)).toBe(true);
    expect(() => assertMatchingEvidenceRoot(root, root)).not.toThrow();
    expect(() =>
      assertMatchingEvidenceRoot(root, `0x${"34".repeat(32)}`),
    ).toThrow("does not match");
    expect(() =>
      assertMatchingEvidenceRoot(`0x${"0".repeat(64)}`, root),
    ).toThrow("non-zero");
    expect(isBytes32("0x1234")).toBe(false);
  });
});
