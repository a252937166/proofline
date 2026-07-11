import "dotenv/config";

import { readFile } from "node:fs/promises";

import solc from "solc";
import { getAddress, isAddress } from "viem";

const addressValue =
  process.argv[2]?.trim() ||
  process.env.PROOF_REGISTRY_ADDRESS?.trim() ||
  process.env.INJECTIVE_REGISTRY_ADDRESS?.trim();
if (!addressValue || !isAddress(addressValue)) {
  throw new Error(
    "Pass the deployed registry address or set PROOF_REGISTRY_ADDRESS.",
  );
}
const address = getAddress(addressValue);
const explorerApi = (
  process.env.PUBLIC_INJECTIVE_EXPLORER_API_URL?.trim() ||
  "https://testnet.blockscout-api.injective.network/api"
).replace(/\/$/, "");
if (!explorerApi.startsWith("https://")) {
  throw new Error("Contract verification requires the public HTTPS Explorer API.");
}

const source = await readFile(
  new URL("../src/MatchProofRegistry.sol", import.meta.url),
  "utf8",
);
const standardInput = {
  language: "Solidity",
  sources: { "MatchProofRegistry.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } },
  },
};
const compilerVersion = `v${solc.version().replace(/\.Emscripten\.clang$/, "")}`;
const verificationUrl =
  `${explorerApi}/v2/smart-contracts/${address}/verification/via/standard-input`;
const form = new FormData();
form.set("compiler_version", compilerVersion);
form.set("contract_name", "MatchProofRegistry");
form.set("autodetect_constructor_args", "true");
form.set("constructor_args", "");
form.set("license_type", "mit");
form.set(
  "files[0]",
  new Blob([JSON.stringify(standardInput)], { type: "application/json" }),
  "proofline-standard-input.json",
);

const submission = await fetch(verificationUrl, {
  method: "POST",
  body: form,
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
const submissionBody = await submission.text();
if (!submission.ok) {
  throw new Error(
    `Explorer verification submission failed (${submission.status}): ${submissionBody.slice(0, 500)}`,
  );
}

// Older Blockscout instances acknowledge the v2 upload before surfacing a
// verifier error. Submit the same canonical input through the compatibility
// API as well so we receive a job id and an explicit terminal status.
const compatibilityForm = new FormData();
compatibilityForm.set("module", "contract");
compatibilityForm.set("action", "verifysourcecode");
compatibilityForm.set("codeformat", "solidity-standard-json-input");
compatibilityForm.set("contractaddress", address);
compatibilityForm.set("contractname", "MatchProofRegistry.sol:MatchProofRegistry");
compatibilityForm.set("compilerversion", compilerVersion);
compatibilityForm.set("sourceCode", JSON.stringify(standardInput));
const compatibilitySubmission = await fetch(explorerApi, {
  method: "POST",
  body: compatibilityForm,
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
const compatibility = (await compatibilitySubmission.json()) as {
  status?: string;
  message?: string;
  result?: string;
};
if (
  !compatibilitySubmission.ok ||
  (compatibility.status !== "1" &&
    !String(compatibility.result ?? "").toLowerCase().includes("already verified"))
) {
  throw new Error(
    `Explorer compatibility verification rejected the input: ${JSON.stringify(compatibility)}`,
  );
}
const verificationGuid =
  compatibility.status === "1" && typeof compatibility.result === "string"
    ? compatibility.result
    : undefined;

const contractUrl = `${explorerApi}/v2/smart-contracts/${address}`;
const deadline = Date.now() + 90_000;
let verified: Record<string, unknown> | undefined;
while (Date.now() < deadline) {
  const response = await fetch(contractUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) {
    const body = (await response.json()) as Record<string, unknown>;
    if (
      body.is_verified === true ||
      (body.name === "MatchProofRegistry" && typeof body.source_code === "string")
    ) {
      verified = body;
      break;
    }
  }
  if (verificationGuid) {
    const statusUrl = new URL(explorerApi);
    statusUrl.searchParams.set("module", "contract");
    statusUrl.searchParams.set("action", "checkverifystatus");
    statusUrl.searchParams.set("guid", verificationGuid);
    const statusResponse = await fetch(statusUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (statusResponse.ok) {
      const status = (await statusResponse.json()) as {
        status?: string;
        result?: string;
      };
      if (
        status.status === "0" &&
        !String(status.result ?? "").toLowerCase().includes("pending")
      ) {
        throw new Error(`Explorer verifier failed: ${String(status.result)}`);
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!verified) {
  throw new Error(
    "Explorer accepted verification but did not publish the verified source within 90 seconds.",
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      verified: true,
      address,
      contractName: verified.name,
      compilerVersion: verified.compiler_version,
      optimizationEnabled: verified.optimization_enabled,
      optimizationRuns: verified.optimization_runs,
      evmVersion: verified.evm_version,
      verifiedAt: verified.verified_at,
      explorerUrl: `https://testnet.blockscout.injective.network/address/${address}?tab=contract`,
      submissionStatus: submission.status,
      compilerRequested: compilerVersion,
    },
    null,
    2,
  )}\n`,
);
