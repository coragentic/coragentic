# Wallet-Approved Proof Runbook

This runbook closes the two remaining external-wallet proof gaps without giving Coragentic custody. It is intentionally a **human-in-the-wallet** procedure.

## Preconditions

- Use an externally controlled wallet on Robinhood Chain (`4663`).
- Verify every contract address independently in the wallet UI before signing.
- Never paste a private key into the API, MCP, browser console, server, or this repository.
- The API is `https://api.coragentic.app`.

## Proof A — ERC-8004 agent identity receipt

1. Connect the wallet in the Coragentic app and create an agent draft.
2. Request `GET /v1/agents/:id/registration-call` through an authenticated wallet session.
3. Confirm the result targets the verified IdentityRegistry:

```text
0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
```

4. The endpoint returns unsigned `register(string)` calldata only. Review it in the wallet and broadcast **from the owner wallet**.
5. Wait for a Robinhood Chain receipt and retain the transaction hash.
6. Verify the receipt independently through an RPC/explorer and retain the transaction hash as the public proof reference.

**What this proves:** a specific external wallet registered a specific identity transaction on the real ERC-8004 registry.  
**What it does not prove:** that every agent is safe, capable, or trusted.

## Proof B — non-custodial USDG x402 settlement receipt

1. Create an active Coragentic offering denominated in USDG.
2. Fetch its x402 payment requirement:

```text
GET /v1/offerings/:id/payment-required
```

3. From the payer's **own wallet**, send the required USDG ERC-20 amount to the requirement's `payTo` address on Robinhood Chain. The payer pays their own gas; Coragentic does not relay anything.
4. Wait for the successful transaction receipt and capture its transaction hash.
5. Submit that hash to:

```text
POST /v1/offerings/:id/settle
{ "txHash": "0x..." }
```

6. Coragentic reads the transaction receipt and verifies a successful USDG `Transfer` log with matching asset, payer, recipient, and amount. The database atomically records the transaction hash; submitting it again must be rejected as replay.
7. Retain the transaction hash, HTTP settlement response, and related audit event as the proof bundle.

**What this proves:** a payer-controlled wallet sent USDG on-chain and Coragentic verified that receipt non-custodially.  
**What it does not prove:** a price, investment outcome, token liquidity, or that Coragentic held either party's funds.

## Evidence bundle template

```text
Proof type: ERC-8004 registration | USDG x402 settlement
Network: eip155:4663
Transaction hash: 0x...
External wallet action: yes
Coragentic server signing/custody: no
Receipt status: 0x1 / success
Verification timestamp (UTC): ...
API response / audit-event reference: ...
```

Do not publish private memory, session bearer tokens, private deliverables, or secrets in a proof bundle.
