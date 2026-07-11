export const PREVIOUSLY_VERIFIED_SAMPLE = {
  label: "France 2–0 Morocco · 2026 final result",
  capturedAt: "2026-07-11T12:50:45.743Z",
  network: "Injective EVM testnet · eip155:1439",
  registry: {
    address: "0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1",
    url: "https://testnet.blockscout.injective.network/address/0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1?tab=contract",
  },
  anchor: {
    transactionHash: "0x24cd0ae9a40dbfdba14563f9f2932451624be63928667b629c4cadc86a507344",
    url: "https://testnet.blockscout.injective.network/tx/0x24cd0ae9a40dbfdba14563f9f2932451624be63928667b629c4cadc86a507344",
  },
  x402: {
    transactionHash: "0x29237a0a3d501ca62882042313fcbb730fd91d152967430b2600545a227b842e",
    price: "0.01 test USDC",
    url: "https://testnet.blockscout.injective.network/tx/0x29237a0a3d501ca62882042313fcbb730fd91d152967430b2600545a227b842e",
  },
  proof: {
    eventHash: "0x8837f43f315336c660ec19791c4a374e7eacdd7ff9d66c546247bbeb89035b30",
    evidenceRoot: "0xe048362103ce6c4f07d95e1a0ebdd81b7b9b9332943d4af978cdde71b62661b3",
    packetHash: "0xb8a16fdf1d5b4b282561ccd508671704ccc7f96540b6978a93eb3aa0a5f1be99",
    issuerAddress: "0xa1a62687df6A60DB9738d424b988A3DA8d029c65",
    evidenceScore: "98.25/100",
    layers: [
      { id: "integrity", label: "Packet integrity", detail: "Canonical event and evidence roots recomputed" },
      { id: "issuer", label: "Trusted issuer", detail: "Policy-versioned EIP-712 key matched the current issuer" },
      { id: "onchain", label: "Latest commitment", detail: "Registry v3 revision 1 matched on testnet" },
    ],
  },
  auditJsonUrl: "/audit/previously-verified-sample.json",
} as const;
