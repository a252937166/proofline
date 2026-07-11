# Judge guide

Proofline offers three evidence levels so a judge never has to wait for a live
match or a wallet before understanding the differentiator.

## 15 seconds — inspect the thesis

1. Open the app.
2. Read the permanent `Historical Replay · Not Live` label.
3. Look at the settlement gate and Proofline confidence rail.
4. Open the current source list and canonical event hash.

The app should already make the claim clear: reported events may be displayed,
but machines cannot act until independent evidence crosses the public line.

## 90 seconds — run the conflict replay

1. Press **Run replay**.
2. Watch the OpenFootball red-card observation appear.
3. The injected provider-lag claim says yellow. VARA switches to `contested` and
   the settlement gate stays held.
4. FIFA corroborates red; the synthetic lag claim is explicitly retracted.
5. The late goals and 0–2 final result arrive from both source families.
6. The verified final-result hash is anchored in the configured demo or testnet
   mode.
7. Request the proof packet. The API first returns `402 Payment Required`; the
   local no-wallet path is labelled sandbox and the testnet path uses native USDC.
8. Run packet verification, then change one source field and verify that the
   packet fails.

## 3–5 minutes — real testnet path

Configure `.env` with an Injective EVM testnet registry, an anchorer key, and
distinct Agent/facilitator wallets. Then:

1. Anchor a new decision and open the Blockscout transaction.
2. Call the proof resource with the Agent x402 client and pay `0.01` test USDC.
3. Compare the x402 settlement transaction with the separate proof anchor.
4. Show the plan-only Base Sepolia → Injective CCTP route and its mandatory
   pre-burn approval. Do not claim a transfer unless executable burn,
   attestation, mint, and balance-recheck work is added and real links exist.

Never use the official Injective demo's transaction as Proofline-owned evidence.

## Required commands

```bash
npm install
npm run check
npm run dev
```

The web app opens at `http://localhost:5173`; the API listens on
`http://localhost:8787`.
