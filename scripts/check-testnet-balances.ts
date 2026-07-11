import "dotenv/config";

import {
  createPublicClient,
  defineChain,
  formatEther,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 1439;
const USDC = "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d" as Address;
const rpcUrl =
  process.env.INJECTIVE_TESTNET_RPC ??
  "https://k8s.testnet.json-rpc.injective.network/";

function accountAddress(key: string): Address {
  const value = process.env[key];
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${key} is missing or invalid in .env`);
  }
  return privateKeyToAccount(value as Hex).address;
}

const roles = {
  deployerAdmin: accountAddress("DEPLOYER_PRIVATE_KEY"),
  anchorerService: accountAddress("ANCHOR_PRIVATE_KEY"),
  facilitatorAndPayee: accountAddress("X402_FACILITATOR_PRIVATE_KEY"),
  agentPayer: accountAddress("X402_AGENT_PRIVATE_KEY"),
};

const chain = defineChain({
  id: CHAIN_ID,
  name: "Injective EVM Testnet",
  nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  testnet: true,
});
const client = createPublicClient({ chain, transport: http(rpcUrl) });

const actualChainId = await client.getChainId();
if (actualChainId !== CHAIN_ID) {
  throw new Error(`Expected chain ${CHAIN_ID}, received ${actualChainId}`);
}

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const balances = await Promise.all(
  Object.entries(roles).map(async ([role, address]) => {
    const [injAtomic, usdcAtomic] = await Promise.all([
      client.getBalance({ address }),
      client.readContract({
        address: USDC,
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [address],
      }),
    ]);
    return {
      role,
      address,
      inj: formatEther(injAtomic),
      usdc: formatUnits(usdcAtomic, 6),
      injAtomic: injAtomic.toString(),
      usdcAtomic: usdcAtomic.toString(),
    };
  }),
);

process.stdout.write(
  `${JSON.stringify(
    {
      network: "eip155:1439",
      rpcChainId: actualChainId,
      usdcContract: USDC,
      checkedAt: new Date().toISOString(),
      balances,
    },
    null,
    2,
  )}\n`,
);
