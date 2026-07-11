export const CIRCLE_USDC_ADDRESS_REFERENCE =
  "https://developers.circle.com/stablecoins/usdc-contract-addresses";

export const CCTP_SOURCE_DEFAULTS = {
  "ethereum-sepolia": {
    caip2: "eip155:11155111",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  },
  "base-sepolia": {
    caip2: "eip155:84532",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
} as const;

function requireAddress(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an EVM address`);
  return value;
}

export function cctpSourceNetworks(env: NodeJS.ProcessEnv = process.env) {
  return {
    "ethereum-sepolia": {
      ...CCTP_SOURCE_DEFAULTS["ethereum-sepolia"],
      usdc: requireAddress(
        env.ETHEREUM_SEPOLIA_USDC ?? CCTP_SOURCE_DEFAULTS["ethereum-sepolia"].usdc,
        "ETHEREUM_SEPOLIA_USDC",
      ),
    },
    "base-sepolia": {
      ...CCTP_SOURCE_DEFAULTS["base-sepolia"],
      usdc: requireAddress(
        env.BASE_SEPOLIA_USDC_ADDRESS ??
          env.BASE_SEPOLIA_USDC ??
          CCTP_SOURCE_DEFAULTS["base-sepolia"].usdc,
        "BASE_SEPOLIA_USDC_ADDRESS",
      ),
    },
  } as const;
}
