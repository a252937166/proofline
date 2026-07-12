import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";

import {
  getWalletDiscoveryStore,
  type DiscoveredWalletProvider,
  type EIP1193Provider,
} from "../lib/eip6963";
import { ensureInjectiveTestnet } from "../lib/wallet";

export const INJECTIVE_TESTNET_CHAIN_HEX = "0x59f";
export const WALLET_RDNS_STORAGE_KEY = "proofline.wallet.rdns.v1";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const EMPTY_PROVIDERS: readonly DiscoveredWalletProvider[] = [];

export type WalletStatus =
  | "undetected"
  | "disconnected"
  | "connecting"
  | "wrong-network"
  | "low-balance"
  | "ready"
  | "error";

export interface WalletState {
  status: WalletStatus;
  providers: readonly DiscoveredWalletProvider[];
  selectedProvider: DiscoveredWalletProvider | null;
  preferredRdns: string | null;
  account: string | null;
  chainId: string | null;
  usdcBalance: bigint | null;
  walletEpoch: number;
  error: string | null;
}

export type WalletAction =
  | { type: "providers-discovered"; providers: readonly DiscoveredWalletProvider[] }
  | { type: "connecting"; provider: DiscoveredWalletProvider }
  | {
      type: "connected" | "refreshed";
      provider: DiscoveredWalletProvider;
      account: string;
      chainId: string;
      usdcBalance: bigint | null;
      minimumBalance: bigint;
    }
  | { type: "account-changed"; provider: DiscoveredWalletProvider; account: string }
  | { type: "chain-changed"; provider: DiscoveredWalletProvider; chainId: string }
  | { type: "disconnected"; provider?: DiscoveredWalletProvider; message?: string }
  | { type: "error"; provider?: DiscoveredWalletProvider; message: string };

export interface UseWalletOptions {
  assetAddress: string | null;
  minimumUsdcBalance?: bigint;
  rpcUrl: string;
  explorerUrl: string;
}

export interface UseWalletResult extends WalletState {
  connect(provider: DiscoveredWalletProvider): Promise<void>;
  disconnect(): void;
  refresh(): Promise<void>;
  requestDiscovery(): void;
  switchNetwork(): Promise<void>;
  watchAsset(): Promise<boolean>;
}

function normalizedChainId(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  return value.toLowerCase();
}

function firstAccount(value: unknown): string | null {
  if (!Array.isArray(value) || typeof value[0] !== "string") return null;
  return ADDRESS_PATTERN.test(value[0]) ? value[0] : null;
}

function statusAfterPreflight(
  chainId: string,
  usdcBalance: bigint | null,
  minimumBalance: bigint,
): WalletStatus {
  if (chainId !== INJECTIVE_TESTNET_CHAIN_HEX) return "wrong-network";
  if (usdcBalance === null) return "connecting";
  return usdcBalance < minimumBalance ? "low-balance" : "ready";
}

function preferredProviders(
  providers: readonly DiscoveredWalletProvider[],
  rdns: string | null,
): readonly DiscoveredWalletProvider[] {
  if (!rdns) return providers;
  return [...providers].sort((left, right) =>
    Number(right.info.rdns === rdns) - Number(left.info.rdns === rdns));
}

function readPreferredRdns(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(WALLET_RDNS_STORAGE_KEY)?.trim();
    return value && value.length <= 253 ? value : null;
  } catch {
    return null;
  }
}

function persistPreferredRdns(rdns: string): void {
  if (typeof window === "undefined") return;
  try {
    // Wallet preference is the only wallet datum persisted. Accounts,
    // signatures, nonces and PAYMENT-SIGNATURE remain memory-only.
    window.localStorage.setItem(WALLET_RDNS_STORAGE_KEY, rdns);
  } catch {
    // Storage can be unavailable in private or hardened browser contexts. The
    // connected provider remains usable for the current page lifetime.
  }
}

export function createInitialWalletState(
  preferredRdns: string | null = null,
): WalletState {
  return {
    status: "undetected",
    providers: EMPTY_PROVIDERS,
    selectedProvider: null,
    preferredRdns,
    account: null,
    chainId: null,
    usdcBalance: null,
    walletEpoch: 0,
    error: null,
  };
}

export function walletReducer(state: WalletState, action: WalletAction): WalletState {
  switch (action.type) {
    case "providers-discovered":
      return {
        ...state,
        providers: preferredProviders(action.providers, state.preferredRdns),
        status: state.status === "undetected" ? "disconnected" : state.status,
      };
    case "connecting":
      return {
        ...state,
        status: "connecting",
        selectedProvider: action.provider,
        account: null,
        chainId: null,
        usdcBalance: null,
        walletEpoch: state.walletEpoch + 1,
        error: null,
      };
    case "connected":
    case "refreshed":
      if (
        action.type === "refreshed" &&
        (state.selectedProvider?.provider !== action.provider.provider ||
          state.account?.toLowerCase() !== action.account.toLowerCase())
      ) {
        return state;
      }
      return {
        ...state,
        status: statusAfterPreflight(
          action.chainId,
          action.usdcBalance,
          action.minimumBalance,
        ),
        selectedProvider: action.provider,
        preferredRdns: action.provider.info.rdns,
        account: action.account,
        chainId: action.chainId,
        usdcBalance: action.usdcBalance,
        error: null,
      };
    case "account-changed":
      if (state.selectedProvider?.provider !== action.provider.provider) return state;
      return {
        ...state,
        status: "connecting",
        account: action.account,
        usdcBalance: null,
        walletEpoch: state.walletEpoch + 1,
        error: "The connected account changed. Review the wallet preflight again.",
      };
    case "chain-changed":
      if (state.selectedProvider?.provider !== action.provider.provider) return state;
      return {
        ...state,
        status: action.chainId === INJECTIVE_TESTNET_CHAIN_HEX
          ? "connecting"
          : "wrong-network",
        chainId: action.chainId,
        usdcBalance: null,
        walletEpoch: state.walletEpoch + 1,
        error: action.chainId === INJECTIVE_TESTNET_CHAIN_HEX
          ? null
          : "Switch to Injective EVM Testnet before signing.",
      };
    case "disconnected":
      if (
        action.provider &&
        state.selectedProvider &&
        state.selectedProvider.provider !== action.provider.provider
      ) return state;
      return {
        ...state,
        status: "disconnected",
        selectedProvider: action.provider ?? state.selectedProvider,
        account: null,
        chainId: null,
        usdcBalance: null,
        walletEpoch: state.walletEpoch + 1,
        error: action.message ?? null,
      };
    case "error":
      return {
        ...state,
        status: "error",
        selectedProvider: action.provider ?? state.selectedProvider,
        error: action.message,
      };
  }
}

function errorCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "code" in error &&
    typeof (error as { code?: unknown }).code === "number"
    ? (error as { code: number }).code
    : undefined;
}

export function walletErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 4001:
      return "The wallet request was rejected.";
    case -32002:
      return "A wallet request is already pending. Open the wallet and finish or reject it.";
    case 4900:
      return "The selected wallet is disconnected.";
    case 4901:
      return "The selected wallet is not connected to Injective EVM Testnet.";
    case -32601:
      return "This wallet does not support the required EIP-712 request. Choose another compatible EVM wallet.";
    default:
      return error instanceof Error && error.message
        ? error.message
        : "The wallet request could not be completed.";
  }
}

export async function readUsdcBalance(
  provider: EIP1193Provider,
  assetAddress: string,
  account: string,
): Promise<bigint> {
  if (!ADDRESS_PATTERN.test(assetAddress) || !ADDRESS_PATTERN.test(account)) {
    throw new Error("Cannot read test USDC balance for an invalid address.");
  }
  const data = `0x70a08231${account.slice(2).toLowerCase().padStart(64, "0")}`;
  const result = await provider.request({
    method: "eth_call",
    params: [{ to: assetAddress, data }, "latest"],
  });
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) {
    throw new Error("The wallet returned an invalid test USDC balance.");
  }
  return BigInt(result);
}

async function readPreflight(
  provider: EIP1193Provider,
  account: string,
  assetAddress: string | null,
): Promise<{ chainId: string; usdcBalance: bigint | null }> {
  const chainId = normalizedChainId(
    await provider.request({ method: "eth_chainId" }),
  );
  if (!chainId) throw new Error("The wallet returned an invalid EVM network.");
  const usdcBalance = chainId === INJECTIVE_TESTNET_CHAIN_HEX && assetAddress
    ? await readUsdcBalance(provider, assetAddress, account)
    : null;
  return { chainId, usdcBalance };
}

export function useWallet(options: UseWalletOptions): UseWalletResult {
  const minimumBalance = options.minimumUsdcBalance ?? 10_000n;
  const [state, dispatch] = useReducer(
    walletReducer,
    undefined,
    () => createInitialWalletState(readPreferredRdns()),
  );
  const operationRef = useRef(0);
  const discovery = getWalletDiscoveryStore();
  const providers = useSyncExternalStore(
    discovery?.subscribe ?? (() => () => undefined),
    discovery?.getSnapshot ?? (() => EMPTY_PROVIDERS),
    () => EMPTY_PROVIDERS,
  );

  useEffect(() => {
    discovery?.start();
  }, [discovery]);

  useEffect(() => {
    dispatch({ type: "providers-discovered", providers });
  }, [providers]);

  const connect = useCallback(async (provider: DiscoveredWalletProvider) => {
    const operation = ++operationRef.current;
    dispatch({ type: "connecting", provider });
    try {
      const accounts = await provider.provider.request({ method: "eth_requestAccounts" });
      const account = firstAccount(accounts);
      if (!account) throw new Error("The wallet did not return a valid EVM account.");
      const preflight = await readPreflight(
        provider.provider,
        account,
        options.assetAddress,
      );
      if (operation !== operationRef.current) return;
      persistPreferredRdns(provider.info.rdns);
      dispatch({
        type: "connected",
        provider,
        account,
        ...preflight,
        minimumBalance,
      });
    } catch (error) {
      if (operation !== operationRef.current) return;
      const message = walletErrorMessage(error);
      if (errorCode(error) === 4001) {
        dispatch({ type: "disconnected", provider, message });
      } else {
        dispatch({ type: "error", provider, message });
      }
    }
  }, [minimumBalance, options.assetAddress]);

  const refresh = useCallback(async () => {
    const provider = state.selectedProvider;
    if (!provider) return;
    const operation = ++operationRef.current;
    try {
      const accounts = await provider.provider.request({ method: "eth_accounts" });
      const account = firstAccount(accounts);
      if (!account) {
        dispatch({ type: "disconnected", provider });
        return;
      }
      if (account.toLowerCase() !== state.account?.toLowerCase()) {
        dispatch({ type: "account-changed", provider, account });
      }
      const preflight = await readPreflight(
        provider.provider,
        account,
        options.assetAddress,
      );
      if (operation !== operationRef.current) return;
      dispatch({
        type: "refreshed",
        provider,
        account,
        ...preflight,
        minimumBalance,
      });
    } catch (error) {
      if (operation !== operationRef.current) return;
      dispatch({ type: "error", provider, message: walletErrorMessage(error) });
    }
  }, [minimumBalance, options.assetAddress, state.account, state.selectedProvider]);

  useEffect(() => {
    const selected = state.selectedProvider;
    if (!selected) return;
    const provider = selected.provider;
    const addListener = provider.on;
    if (!addListener) return;

    const handleAccountsChanged = (...args: unknown[]) => {
      const account = firstAccount(args[0]);
      const operation = ++operationRef.current;
      if (!account) {
        dispatch({ type: "disconnected", provider: selected });
        return;
      }
      dispatch({ type: "account-changed", provider: selected, account });
      void readPreflight(provider, account, options.assetAddress)
        .then((preflight) => {
          if (operation !== operationRef.current) return;
          dispatch({
            type: "refreshed",
            provider: selected,
            account,
            ...preflight,
            minimumBalance,
          });
        })
        .catch((error: unknown) => {
          if (operation !== operationRef.current) return;
          dispatch({
            type: "error",
            provider: selected,
            message: walletErrorMessage(error),
          });
        });
    };
    const handleChainChanged = (...args: unknown[]) => {
      const chainId = normalizedChainId(args[0]);
      if (!chainId) return;
      ++operationRef.current;
      dispatch({ type: "chain-changed", provider: selected, chainId });
    };
    const handleDisconnect = () => {
      ++operationRef.current;
      dispatch({
        type: "disconnected",
        provider: selected,
        message: "The selected wallet disconnected.",
      });
    };

    addListener.call(provider, "accountsChanged", handleAccountsChanged);
    addListener.call(provider, "chainChanged", handleChainChanged);
    addListener.call(provider, "disconnect", handleDisconnect);
    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
      provider.removeListener?.("disconnect", handleDisconnect);
    };
  }, [minimumBalance, options.assetAddress, state.selectedProvider]);

  // Integration data can arrive after a previously connected wallet. Refresh
  // the balance as soon as the canonical test USDC address becomes available.
  useEffect(() => {
    if (
      state.selectedProvider &&
      state.account &&
      state.chainId === INJECTIVE_TESTNET_CHAIN_HEX &&
      options.assetAddress &&
      state.usdcBalance === null
    ) {
      void refresh();
    }
  }, [options.assetAddress, refresh, state.account, state.chainId, state.selectedProvider, state.usdcBalance]);

  const disconnect = useCallback(() => {
    ++operationRef.current;
    dispatch({
      type: "disconnected",
      ...(state.selectedProvider ? { provider: state.selectedProvider } : {}),
    });
  }, [state.selectedProvider]);

  const requestDiscovery = useCallback(() => {
    discovery?.requestProviders();
  }, [discovery]);

  const switchNetwork = useCallback(async () => {
    const selected = state.selectedProvider;
    if (!selected) return;
    try {
      await ensureInjectiveTestnet(
        selected.provider,
        options.rpcUrl,
        options.explorerUrl,
      );
      await refresh();
    } catch (error) {
      dispatch({
        type: "error",
        provider: selected,
        message: walletErrorMessage(error),
      });
    }
  }, [options.explorerUrl, options.rpcUrl, refresh, state.selectedProvider]);

  const watchAsset = useCallback(async (): Promise<boolean> => {
    const selected = state.selectedProvider;
    if (!selected || !options.assetAddress) return false;
    try {
      const result = await selected.provider.request({
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address: options.assetAddress,
            symbol: "USDC",
            decimals: 6,
          },
        },
      });
      return result === true;
    } catch (error) {
      dispatch({
        type: "error",
        provider: selected,
        message: walletErrorMessage(error),
      });
      return false;
    }
  }, [options.assetAddress, state.selectedProvider]);

  return {
    ...state,
    connect,
    disconnect,
    refresh,
    requestDiscovery,
    switchNetwork,
    watchAsset,
  };
}
