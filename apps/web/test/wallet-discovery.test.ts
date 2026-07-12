import { describe, expect, it, vi } from "vitest";

import {
  WalletDiscoveryStore,
  normalizeAnnouncedProvider,
  type EIP1193Provider,
  type EIP1193RequestArguments,
  type WalletDiscoveryWindow,
} from "../src/lib/eip6963";
import {
  createInitialWalletState,
  walletReducer,
} from "../src/hooks/useWallet";

const ACCOUNT = "0x3333333333333333333333333333333333333333";

class FakeWindow extends EventTarget implements WalletDiscoveryWindow {
  ethereum?: EIP1193Provider;
}

function provider(
  request: (args: EIP1193RequestArguments) => Promise<unknown> = async () => null,
): EIP1193Provider {
  return { request };
}

function detail(
  id: string,
  name: string,
  rdns: string,
  selectedProvider: EIP1193Provider,
) {
  return {
    info: {
      uuid: id,
      name,
      rdns,
      icon: "data:image/png;base64,AA==",
    },
    provider: selectedProvider,
  };
}

function announce(target: EventTarget, value: unknown): void {
  target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: value }));
}

describe("EIP-6963 wallet discovery", () => {
  it("requests providers, preserves provider-neutral metadata, and deduplicates announcements", () => {
    const target = new FakeWindow();
    const alpha = provider();
    const beta = provider();
    const alphaDetail = detail(
      "11111111-1111-4111-8111-111111111111",
      "Alpha Wallet",
      "io.alpha.wallet",
      alpha,
    );
    const betaDetail = detail(
      "22222222-2222-4222-8222-222222222222",
      "Beta Wallet",
      "io.beta.wallet",
      beta,
    );
    target.addEventListener("eip6963:requestProvider", () => {
      announce(target, alphaDetail);
      announce(target, alphaDetail);
      announce(target, betaDetail);
      // A duplicate UUID cannot smuggle a second provider into the selector.
      announce(target, { ...alphaDetail, provider: provider() });
      // A provider object re-announced with a different UUID is still one entry.
      announce(target, detail(
        "33333333-3333-4333-8333-333333333333",
        "Alpha Wallet Duplicate",
        "io.alpha.wallet",
        alpha,
      ));
    });
    const store = new WalletDiscoveryStore(target);
    const listener = vi.fn();
    store.subscribe(listener);

    store.start();

    expect(store.getSnapshot()).toHaveLength(2);
    expect(store.getSnapshot().map((entry) => entry.info.name)).toEqual([
      "Alpha Wallet",
      "Beta Wallet",
    ]);
    expect(store.getSnapshot().every((entry) => entry.source === "eip6963")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("uses window.ethereum only as a generic fallback", () => {
    const target = new FakeWindow();
    const fallback = provider();
    target.ethereum = fallback;
    const store = new WalletDiscoveryStore(target);

    store.start();

    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]).toMatchObject({
      source: "window.ethereum",
      info: { name: "Browser wallet", rdns: "fallback.window.ethereum" },
      provider: fallback,
    });
  });

  it("replaces the fallback when the same provider later announces EIP-6963 metadata", () => {
    const target = new FakeWindow();
    const selectedProvider = provider();
    target.ethereum = selectedProvider;
    const store = new WalletDiscoveryStore(target);
    store.start();
    expect(store.getSnapshot()[0]?.source).toBe("window.ethereum");

    announce(target, detail(
      "44444444-4444-4444-8444-444444444444",
      "Dynamic Wallet Name",
      "xyz.dynamic.wallet",
      selectedProvider,
    ));

    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]).toMatchObject({
      source: "eip6963",
      info: { name: "Dynamic Wallet Name", rdns: "xyz.dynamic.wallet" },
      provider: selectedProvider,
    });
  });

  it("drops unsafe icon schemes while retaining the wallet", () => {
    const selectedProvider = provider();
    const normalized = normalizeAnnouncedProvider({
      ...detail(
        "55555555-5555-4555-8555-555555555555",
        "Neutral Wallet",
        "dev.neutral.wallet",
        selectedProvider,
      ),
      info: {
        uuid: "55555555-5555-4555-8555-555555555555",
        name: "Neutral Wallet",
        rdns: "dev.neutral.wallet",
        icon: "javascript:alert(1)",
      },
    });

    expect(normalized).toMatchObject({
      info: { name: "Neutral Wallet", icon: "" },
      provider: selectedProvider,
    });
  });
});
describe("wallet state reducer", () => {
  it("tracks the selected provider, preflight state and wallet epoch", () => {
    const selectedProvider = provider();
    const announced = normalizeAnnouncedProvider(detail(
      "66666666-6666-4666-8666-666666666666",
      "Reducer Wallet",
      "dev.reducer.wallet",
      selectedProvider,
    ));
    expect(announced).not.toBeNull();
    if (!announced) return;

    let state = createInitialWalletState("dev.reducer.wallet");
    state = walletReducer(state, {
      type: "providers-discovered",
      providers: [announced],
    });
    expect(state.status).toBe("disconnected");

    state = walletReducer(state, { type: "connecting", provider: announced });
    expect(state.walletEpoch).toBe(1);
    state = walletReducer(state, {
      type: "connected",
      provider: announced,
      account: ACCOUNT,
      chainId: "0x59f",
      usdcBalance: 20_000n,
      minimumBalance: 10_000n,
    });
    expect(state).toMatchObject({
      status: "ready",
      account: ACCOUNT,
      chainId: "0x59f",
      usdcBalance: 20_000n,
      preferredRdns: "dev.reducer.wallet",
    });

    state = walletReducer(state, {
      type: "chain-changed",
      provider: announced,
      chainId: "0x1",
    });
    expect(state.status).toBe("wrong-network");
    expect(state.walletEpoch).toBe(2);

    state = walletReducer(state, {
      type: "account-changed",
      provider: announced,
      account: "0x4444444444444444444444444444444444444444",
    });
    expect(state.status).toBe("connecting");
    expect(state.walletEpoch).toBe(3);
    expect(state.usdcBalance).toBeNull();
  });

  it("marks a connected account with insufficient test USDC without checking INJ", () => {
    const selectedProvider = provider();
    const announced = normalizeAnnouncedProvider(detail(
      "77777777-7777-4777-8777-777777777777",
      "Balance Wallet",
      "dev.balance.wallet",
      selectedProvider,
    ));
    expect(announced).not.toBeNull();
    if (!announced) return;
    let state = walletReducer(
      createInitialWalletState(),
      { type: "connecting", provider: announced },
    );

    state = walletReducer(state, {
      type: "connected",
      provider: announced,
      account: ACCOUNT,
      chainId: "0x59f",
      usdcBalance: 9_999n,
      minimumBalance: 10_000n,
    });

    expect(state.status).toBe("low-balance");
    expect(state.usdcBalance).toBe(9_999n);
  });
});
