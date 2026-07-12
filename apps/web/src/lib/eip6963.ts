export interface EIP1193RequestArguments {
  method: string;
  params?: readonly unknown[] | Record<string, unknown>;
}

export type EIP1193Listener = (...args: unknown[]) => void;

export interface EIP1193Provider {
  request(args: EIP1193RequestArguments): Promise<unknown>;
  on?(event: string, listener: EIP1193Listener): void;
  removeListener?(event: string, listener: EIP1193Listener): void;
}

export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
}

export interface DiscoveredWalletProvider {
  id: string;
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
  source: "eip6963" | "window.ethereum";
}

export interface WalletDiscoveryWindow extends EventTarget {
  ethereum?: EIP1193Provider;
}

const ANNOUNCE_EVENT = "eip6963:announceProvider";
const REQUEST_EVENT = "eip6963:requestProvider";
const FALLBACK_ID = "proofline-window-ethereum-fallback";
const FALLBACK_RDNS = "fallback.window.ethereum";
const MAX_ICON_LENGTH = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProvider(value: unknown): value is EIP1193Provider {
  return isRecord(value) && typeof value.request === "function";
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= maximum ? clean : null;
}

function safeIcon(value: unknown): string {
  const icon = cleanText(value, MAX_ICON_LENGTH);
  // EIP-6963 requires data URIs. The UI must still render this value through an
  // <img> element; it must never inject an announced SVG into the page markup.
  return icon?.toLowerCase().startsWith("data:image/") ? icon : "";
}

export function normalizeAnnouncedProvider(
  value: unknown,
): DiscoveredWalletProvider | null {
  if (!isRecord(value) || !isRecord(value.info) || !isProvider(value.provider)) {
    return null;
  }
  const uuid = cleanText(value.info.uuid, 128);
  const name = cleanText(value.info.name, 96);
  const rdns = cleanText(value.info.rdns, 253);
  if (!uuid || !name || !rdns) return null;

  return {
    id: uuid,
    info: {
      uuid,
      name,
      icon: safeIcon(value.info.icon),
      rdns,
    },
    provider: value.provider,
    source: "eip6963",
  };
}

function fallbackProvider(provider: EIP1193Provider): DiscoveredWalletProvider {
  return {
    id: FALLBACK_ID,
    info: {
      uuid: FALLBACK_ID,
      name: "Browser wallet",
      icon: "",
      rdns: FALLBACK_RDNS,
    },
    provider,
    source: "window.ethereum",
  };
}

type StoreListener = () => void;

/**
 * Page-lifetime EIP-6963 registry. It keeps provider objects in memory only;
 * names, icons and rdns values are self-reported display metadata, never trust
 * signals. A window.ethereum entry is used only when no wallet announces via
 * EIP-6963 and is replaced if that same provider announces later.
 */
export class WalletDiscoveryStore {
  private providers: readonly DiscoveredWalletProvider[] = [];
  private readonly listeners = new Set<StoreListener>();
  private started = false;

  constructor(private readonly target: WalletDiscoveryWindow) {}

  readonly getSnapshot = (): readonly DiscoveredWalletProvider[] => this.providers;

  readonly subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    // EIP-6963 asks DApps to keep this listener for the page lifetime, so the
    // production singleton deliberately does not remove it after discovery.
    this.target.addEventListener(ANNOUNCE_EVENT, this.handleAnnouncement);
    this.requestProviders();
    if (this.providers.length === 0 && isProvider(this.target.ethereum)) {
      this.providers = [fallbackProvider(this.target.ethereum)];
      this.emit();
    }
  }

  requestProviders(): void {
    this.target.dispatchEvent(new Event(REQUEST_EVENT));
  }

  private readonly handleAnnouncement = (event: Event): void => {
    const detail = event instanceof CustomEvent ? event.detail : undefined;
    const announced = normalizeAnnouncedProvider(detail);
    if (!announced) return;

    const sameProviderIndex = this.providers.findIndex(
      (candidate) => candidate.provider === announced.provider,
    );
    if (sameProviderIndex >= 0) {
      const existing = this.providers[sameProviderIndex];
      if (existing?.source === "window.ethereum") {
        const next = [...this.providers];
        next[sameProviderIndex] = announced;
        this.providers = next;
        this.emit();
      }
      return;
    }
    if (this.providers.some((candidate) => candidate.id === announced.id)) return;

    // Once at least one standards-based wallet is present, the mutable legacy
    // global is no longer needed as a discovery fallback.
    this.providers = [
      ...this.providers.filter((candidate) => candidate.source !== "window.ethereum"),
      announced,
    ];
    this.emit();
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

let browserStore: WalletDiscoveryStore | null = null;

export function getWalletDiscoveryStore(): WalletDiscoveryStore | null {
  if (typeof window === "undefined") return null;
  browserStore ??= new WalletDiscoveryStore(window as WalletDiscoveryWindow);
  return browserStore;
}
