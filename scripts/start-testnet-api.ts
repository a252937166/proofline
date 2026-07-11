import "dotenv/config";

import { spawn } from "node:child_process";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { readRuntimeConfig } from "../apps/api/src/config.js";

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CHAIN_MODE: "injective-testnet",
  X402_MODE: "injective-testnet",
};
const config = readRuntimeConfig(childEnv);

if (config.anchor.mode !== "injective-testnet") {
  throw new Error(
    "Real anchoring is incomplete. Deploy the registry and configure the anchorer key first.",
  );
}
if (
  config.x402.mode !== "live" ||
  !config.x402.configured ||
  !config.x402.facilitatorPrivateKey ||
  !config.x402.payTo
) {
  throw new Error(
    "The official local x402 facilitator requires X402_FACILITATOR_PRIVATE_KEY and X402_PAY_TO.",
  );
}

const facilitatorAddress = privateKeyToAccount(
  config.x402.facilitatorPrivateKey,
).address;
if (getAddress(config.x402.payTo) !== facilitatorAddress) {
  throw new Error(
    "X402_PAY_TO must equal the address derived from the local facilitator key.",
  );
}

process.stdout.write(
  "Starting Proofline with real Injective testnet anchor configuration and the official inline x402 facilitator. Startup itself submits no transaction.\n",
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["run", "dev", "-w", "@proofline/api"], {
  cwd: process.cwd(),
  env: childEnv,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
