# Real Injective testnet runbook

This runbook proves the real registry → anchor → official x402 local
facilitator → Agent payer loop. It never requires a live football match. The
saved Wales–Iran replay remains labelled historical throughout.

The safe commands are read-only by default. They may read public chain state or
create an EIP-3009 signature in memory, but they do not submit it. Existing
private keys are read only from the gitignored `.env`; scripts print public
addresses, balances, hashes, and transaction receipts, never private keys or
payment signatures.

## 1. Confirm the local secret boundary

`.env` must be mode `0600` and `.gitignore` must contain an exact `.env` rule.
The generated roles are:

- deployer/admin: contract deployment only;
- anchorer service: API registry writes;
- local facilitator/payee: official x402 verification and sponsored gas;
- Agent payer: EIP-3009 authorization only.

Do not put `PROOFLINE_TESTNET_WRITE_ACK` in `.env`. It is deliberately an
ephemeral, per-command acknowledgement.

## 2. Deploy once and persist the registry

`npm run deploy:contract` is the only deployment command and **does broadcast**
to chain ID `1439`. After the deployment receipt and optional anchorer-role
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
- registry bytecode and `REGISTRY_ID` match Proofline;
- the runtime signer has the anchorer role;
- canonical testnet USDC, `exact`, price, payee, and Agent/facilitator separation;
- anchorer/facilitator test INJ and Agent test-USDC readiness.

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

## 5. Prepare or explicitly send one anchor

Safe preparation:

```bash
npm run anchor:testnet
```

This replays every frame before the explicit anchor frame, computes the final
event hash, checks the registry for an existing proof, and exits with
`transactionsSubmitted: 0`. If the same event hash is already valid, it refuses
to create a duplicate revision or spend more gas.

Only when a funded testnet write is intentionally required:

```bash
PROOFLINE_TESTNET_WRITE_ACK=I_UNDERSTAND_ONE_INJECTIVE_TESTNET_ANCHOR_WILL_BE_SENT \
  npm run anchor:testnet -- --broadcast
```

The script permits exactly the replay's next anchor frame, then requires a real
confirmed receipt and an open settlement gate.

## 6. Exercise the official Agent payer

Safe quote and sign-only test:

```bash
npm run buy:proof
```

The Agent checks the exact network, canonical USDC contract, payee, price cap,
allowed API origin, redirect policy, and frozen packet hash. It then uses the
official Injective client to create an EIP-3009 authorization in memory, checks
its encoding, prints no signature, sends nothing, and exits with
`transactionsSubmitted: 0`.

Only when one `0.01` test-USDC settlement is intentionally required:

```bash
PROOFLINE_TESTNET_WRITE_ACK=I_UNDERSTAND_0.01_TEST_USDC_WILL_BE_SETTLED \
  npm run buy:proof -- --pay
```

The API's inline facilitator verifies the authorization, sponsors the
Injective transaction, and returns `PAYMENT-RESPONSE`. The Agent accepts success
only when the receipt network and payer match the signed request and a
transaction hash is present.

## 7. Local tests without funds

```bash
npm run test:workflow
npm run test -w @proofline/api
npm run typecheck
```

The API suite boots the official inline facilitator and verifies its native
402 quote shape against a deliberately unreachable local RPC. Any unexpected
RPC or settlement attempt would fail the test. Workflow tests cover dotenv
registry replacement, origin/session restrictions, and the two-part write
acknowledgements.

## Evidence to retain

- `contracts/deployments/injective-testnet-1439.json`;
- registry address and deployment explorer link;
- one anchor transaction and matching event hash;
- one x402 settlement transaction and paid packet hash;
- output from `npm run testnet:preflight` with `transactionsSubmitted: 0`.

Never substitute a sandbox receipt for one of the two real transactions.
