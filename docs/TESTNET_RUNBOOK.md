# Real Injective testnet runbook

This runbook proves the real Registry v3 → 2026 multi-source evidence
commitment → official x402 local facilitator → Agent payer loop. It never
requires a live football match. France–Morocco is a delayed snapshot, while the
saved Wales–Iran case remains the separate conflict replay.

The safe commands are read-only by default. They may read public chain state or
create an EIP-3009 signature in memory, but they do not submit it. Existing
private keys are read only from the gitignored `.env`; scripts print public
addresses, balances, hashes, and transaction receipts, never private keys or
payment signatures.

## What is proved where

Keep the two hashes separate in screenshots, logs, and judging claims:

- `evidenceRoot` is the **on-chain commitment**. It binds the normalized event,
  provider source-snapshot hashes, receipt/event times, adapter version, policy
  hash, verifier version, and the deterministic verification result. Registry
  v3 stores it beside `matchIdHash`, `eventHash`, evidence score, observation
  time, revision, and state.
- `packetHash` is the hash of the complete portable proof packet. It is
  **off-chain** and is signed by the packet issuer with EIP-712. The x402 quote
  is frozen to this hash. `packetHash` is not described as a chain commitment.

`POST /api/proofs/verify` reports the layers separately: deterministic packet
integrity, recovered issuer signature, and a fresh match-wide latest Registry
v3 read. A packet can pass the first two layers while the on-chain layer is
unavailable or invalid; clients must not collapse those results.

## 1. Confirm the local secret boundary

`.env` must be mode `0600` and `.gitignore` must contain an exact `.env` rule.
The generated roles are:

- deployer/admin: contract deployment only;
- anchorer service: API registry writes;
- local facilitator/payee: official x402 verification and sponsored gas;
- Agent payer: EIP-3009 authorization only.

Do not put `PROOFLINE_TESTNET_WRITE_ACK` in `.env`. It is deliberately an
ephemeral, per-command acknowledgement.

The optional independent explorer API base is:

```dotenv
PUBLIC_INJECTIVE_EXPLORER_API_URL=https://testnet.blockscout-api.injective.network/api
```

This is a separate API hostname. Do not derive it by appending `/api` to the
Blockscout web origin.

## 2. Deploy once and persist the registry

`npm run deploy:contract` is the only deployment command and **does broadcast**
Registry v3 to chain ID `1439`. After the deployment receipt and optional anchorer-role
grant both succeed, it:

1. writes `contracts/deployments/injective-testnet-1439.json`;
2. atomically sets `PROOF_REGISTRY_ADDRESS` in `.env`;
3. restores `.env` permissions to `0600`;
4. leaves `CHAIN_MODE` unchanged.

This ordering preserves the public contract address even if the local dotenv
update later fails, while avoiding an automatic switch into transaction mode.

## 3. Run the no-write preflight

```bash
npm run testnet:preflight
```

The preflight checks, without submitting a transaction:

- RPC chain ID is `1439`;
- registry bytecode and `REGISTRY_ID` match
  `proofline.match-proof-registry.v3`;
- the six-field `verifyLatestSettlementProof` view decodes successfully,
  including `evidenceRoot`, while the only write surface is seven-argument
  `appendRevision(...,state,expectedPreviousDecisionHash)`;
- the runtime signer has the anchorer role;
- canonical testnet USDC, `exact`, price, payee, and Agent/facilitator separation;
- anchorer/facilitator test INJ and Agent test-USDC readiness.

The output also records the explorer API base with
`transactionsSubmitted: 0`. RPC state is authoritative for the latest registry
revision. If an RPC provider has not indexed a just-mined receipt, the official
independent explorer API is the receipt/input fallback:

```text
GET https://testnet.blockscout-api.injective.network/api/v2/transactions/<txHash>
GET https://testnet.blockscout-api.injective.network/api?module=transaction&action=gettxinfo&txhash=<txHash>
```

The fallback must still agree with the RPC registry state, contract address,
transaction input, and success status; an explorer response alone does not
open the settlement gate.

Missing registry state or zero required balances produce `ok: false`, explicit
phase-level `ready: false` values, and a non-zero exit status; they are never
replaced with fake receipts. The funded-independent unit tests below still
exercise quote and write-authorization policy without chain writes.

## 4. Start the real local services

```bash
npm run testnet:api
```

This starts the API with `CHAIN_MODE=injective-testnet` and
`X402_MODE=injective-testnet`, requiring both the deployed registry and the
official `@injectivelabs/x402` inline facilitator configuration. Startup submits
no transaction. Leave this terminal running.

The anchor and payer scripts share `PROOFLINE_SESSION_ID` (default
`proofline-testnet-judge`), so the frozen proof quote belongs to the same replay
that produced the anchor.

## 5. Verify and anchor the 2026 result

The product endpoint runs the frozen ESPN/FIFA observations through VARA and
uses the same idempotent anchor service as the replay:

```bash
curl -X POST \
  'http://127.0.0.1:8787/api/matches/WC-2026-M97-FRA-MAR/verify-anchor?eventId=final-result'
```

If the same `eventHash` and `evidenceRoot` already exist as the latest
revision, the API recovers the original Explorer transaction and sends no
duplicate. The published execution is transaction
`0x24cd0ae9a40dbfdba14563f9f2932451624be63928667b629c4cadc86a507344`.

## 6. Prepare or explicitly send the conflict-replay anchor

Safe preparation:

```bash
npm run anchor:testnet
```

This replays every frame before the explicit anchor frame, computes the final
`eventHash` and `evidenceRoot`, reads the **match-wide latest settlement
revision**, and exits with `transactionsSubmitted: 0`. If that latest revision
already commits both hashes, it refuses to create a duplicate revision or
spend more gas.

Only when a funded testnet write is intentionally required:

```bash
PROOFLINE_TESTNET_WRITE_ACK=I_UNDERSTAND_ONE_INJECTIVE_TESTNET_ANCHOR_WILL_BE_SENT \
  npm run anchor:testnet -- --broadcast
```

The script permits exactly the replay's next anchor frame. The API is the sole
transaction boundary: it submits those five commitment fields through the
concurrency-guarded `appendRevision` path, together with state and the expected
previous decision hash. The script then
requires a real receipt, rereads `verifyLatestSettlementProof`, checks the
on-chain `evidenceRoot`, event hash, score and state, and finally requires an
open settlement gate. A superseded historical revision never satisfies this
check.

## 7. Exercise the official Agent payer

Safe quote and sign-only test:

```bash
npm run buy:proof
```

Set `PROOFLINE_PAID_PROOF_URL` to the 2026 proof endpoint for the submitted
path. The Agent checks the exact network, canonical USDC contract, payee, price cap,
allowed API origin, redirect policy, and frozen packet hash. It then uses the
official Injective client to create an EIP-3009 authorization in memory, checks
its encoding, adds a ProofPurchase EIP-712 signature over packet hash, payee,
amount, deadline, USDC nonce, and session, prints no signature, sends nothing, and exits with
`transactionsSubmitted: 0`.

Only when one `0.01` test-USDC settlement is intentionally required:

```bash
PROOFLINE_TESTNET_WRITE_ACK=I_UNDERSTAND_0.01_TEST_USDC_WILL_BE_SETTLED \
  npm run buy:proof -- --pay
```

The API's inline facilitator verifies the authorization, sponsors the
Injective transaction, and returns `PAYMENT-RESPONSE`. The Agent accepts success
only when the receipt network and payer match the signed request and a
transaction hash is present. The returned packet must retain the exact frozen
`packetHash`, `evidenceRoot`, `issuerAddress`, and EIP-712 `issuerSignature`.

The payer script then posts that purchased packet to `/api/proofs/verify`. It
reports `paid-and-verified` only when packet integrity, issuer signature, and a
fresh latest on-chain settlement read are all valid. If payment settled but a
proof layer fails, it prints `paid-proof-verification-failed` with the payment
transaction and exits non-zero; preserve that receipt and do not retry the
payment automatically.

The published 2026 settlement is
`0x29237a0a3d501ca62882042313fcbb730fd91d152967430b2600545a227b842e`.
Its entitlement persists the frozen packet and hashes of both authorizations;
it never stores the replayable payment header.

## 8. Local tests without funds

```bash
npm run test:workflow
npm run test -w @proofline/api
npm run typecheck
```

The API suite boots the official inline facilitator and verifies its native
402 quote shape against a deliberately unreachable local RPC. Any unexpected
RPC or settlement attempt would fail the test. Workflow tests cover dotenv
registry replacement, origin/session restrictions, Registry v3 identity,
evidence-root equality, and the two-part write acknowledgements. The smoke
workflow also tampers with `evidenceRoot` and requires both packet integrity and
issuer-signature validation to reject it.

## Evidence to retain

- `contracts/deployments/injective-testnet-1439.json`;
- registry address and deployment explorer link;
- one anchor transaction with matching `eventHash` **and on-chain
  `evidenceRoot`** from `verifyLatestSettlementProof`;
- one x402 settlement transaction and the paid packet's off-chain signed
  `packetHash`, issuer address, and issuer signature verification result;
- output from `npm run testnet:preflight` with `transactionsSubmitted: 0`.

Never substitute a sandbox receipt for one of the two real transactions.
