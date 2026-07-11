import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const exampleUrl = new URL("../.env.example", import.meta.url);
const envUrl = new URL("../.env", import.meta.url);
const manifestUrl = new URL(
  "../data/runtime/testnet-wallets.json",
  import.meta.url,
);

async function optionalFile(url: URL): Promise<string | null> {
  try {
    return await readFile(url, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

function readEnvValue(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  const value = match?.[1]?.trim();
  return value || undefined;
}

function setEnvValue(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content.trimEnd()}\n${line}\n`;
}

function existingOrGenerate(
  content: string,
  key: string,
  fallback?: Hex,
): { privateKey: Hex; created: boolean } {
  const current = readEnvValue(content, key);
  if (current && PRIVATE_KEY_PATTERN.test(current)) {
    return { privateKey: current as Hex, created: false };
  }
  return { privateKey: fallback ?? generatePrivateKey(), created: true };
}

const existingEnv = await optionalFile(envUrl);
let envContent = existingEnv ?? (await readFile(exampleUrl, "utf8"));

// Three isolated roles keep the deployer/admin key away from runtime services
// while preventing an Agent payer from ever sharing a merchant key.
const deployer = existingOrGenerate(envContent, "DEPLOYER_PRIVATE_KEY");
const service = existingOrGenerate(envContent, "ANCHOR_PRIVATE_KEY");
const facilitator = existingOrGenerate(
  envContent,
  "X402_FACILITATOR_PRIVATE_KEY",
  service.privateKey,
);
const agentPayer = existingOrGenerate(envContent, "X402_AGENT_PRIVATE_KEY");

const deployerAccount = privateKeyToAccount(deployer.privateKey);
const serviceAccount = privateKeyToAccount(service.privateKey);
const facilitatorAccount = privateKeyToAccount(facilitator.privateKey);
const agentPayerAccount = privateKeyToAccount(agentPayer.privateKey);

for (const [key, value] of [
  ["DEPLOYER_PRIVATE_KEY", deployer.privateKey],
  ["ANCHOR_PRIVATE_KEY", service.privateKey],
  ["X402_FACILITATOR_PRIVATE_KEY", facilitator.privateKey],
  ["X402_AGENT_PRIVATE_KEY", agentPayer.privateKey],
  ["X402_PAY_TO", facilitatorAccount.address],
  ["PROOFLINE_ALLOWED_PAYEE", facilitatorAccount.address],
] as const) {
  envContent = setEnvValue(envContent, key, value);
}

await writeFile(envUrl, envContent, { encoding: "utf8", mode: 0o600 });
await chmod(envUrl, 0o600);

const manifest = {
  schema: "proofline.testnet-wallets.v1",
  network: "Injective EVM testnet",
  chainId: 1439,
  createdAt: new Date().toISOString(),
  roles: {
    deployerAdmin: deployerAccount.address,
    anchorerService: serviceAccount.address,
    facilitatorAndPayee: facilitatorAccount.address,
    agentPayer: agentPayerAccount.address,
  },
  privateKeys: {
    location: ".env",
    permissions: "0600",
    exposedInManifest: false,
  },
};

await mkdir(new URL("../data/runtime/", import.meta.url), { recursive: true });
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

process.stdout.write(
  `${JSON.stringify(
    {
      repositoryRoot,
      reusedExistingEnv: existingEnv !== null,
      ...manifest,
      next: [
        "Fund deployerAdmin and anchorerService with test INJ for deployment/anchoring gas.",
        "Fund agentPayer with Injective testnet USDC for the real x402 judge path.",
        "Never send mainnet assets to these testnet-only addresses.",
      ],
    },
    null,
    2,
  )}\n`,
);
