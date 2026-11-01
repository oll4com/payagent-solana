# PayAgent on Solana

An AI agent paid per task on Solana: a policy gate decides before any work runs, the customer pays the task with x402 on
Solana devnet or from any chain through Aurora Intents, and every step lands in a hash-chained audit log.

Entry for the Encode Club Solana Hackathon 2026 (Aurora Intents track). Work in progress: the devnet x402 flow works end to
end; the Aurora Intents deposit flow and the web page are being built. Nothing here is deployed yet.

## How Solana powers it

- The task's result is an x402 resource: `GET /api/tasks/:id/result` answers `402 Payment Required` with an `exact`
  requirement (network `solana-devnet`, devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, the task's price, the
  owner's address). The customer's wallet signs a USDC transfer; the PayAI facilitator verifies and settles it on Solana
  and pays the network fee. The result unlocks only after settlement, and the transaction id goes into the audit log.
- A payment that does not match the task (amount, asset, network, receiver) or fails to settle is refused with a new 402
  naming the reason, and logged as `PAYMENT_REFUSED`; the task stays payable.
- Paying from another chain (Aurora Intents, in progress): a deposit address on Arbitrum or Base that delivers USDC on
  Solana to the owner; the task unlocks when the swap reports SUCCESS, failed swaps are refunded by Aurora.

## Run it on devnet

```
npm install
cp .env.example .env    # then fill in the addresses and keys it names
npm test                # unit tests; LIVE=1 node --env-file=.env --test test/devnet.live.test.js pays 0.01 devnet USDC
REVIEW_TOKEN=<24+ random characters> AGENT_MODE=echo node --env-file=.env src/server.js
scripts/demo-devnet.sh http://127.0.0.1:8787 "Write a haiku about Solana" 10000
```

`AGENT_MODE=echo` answers with a test echo; for a real model set `AGENT_API_URL` (an OpenAI-compatible `/v1` base),
`AGENT_API_KEY` and `AGENT_MODEL`. The customer's wallet needs devnet USDC (https://faucet.circle.com, Solana Devnet); it
needs no SOL, the facilitator pays the fee. `scripts/demo-devnet.sh` submits a task, shows the 402, pays it with
`scripts/devnet-pay.mjs`, prints the unlocked result and the verified audit log.

Policy (src/policy.js): tasks up to 1 USDC and 1,000 characters run at once; larger ones wait for a reviewer
(`POST /api/tasks/:id/review` with `x-review-token`); secrets and abuse are refused; prices outside 0.01-5 USDC are refused.

## Prior work (disclosed)

These files come unchanged from [payagent](https://github.com/oll4com/payagent) (MIT, commit 8680441), built from
27 October 2026 for BCH BLAZE 2026:

- `src/policy.js`: the AUTO / APPROVE / REFUSE gate in front of the agent.
- `src/audit.js`: the append-only, hash-chained audit log.
- `src/agent.js`: the call to an OpenAI-compatible model endpoint.

Everything about Solana and Aurora Intents is new in this repository and built during the hackathon (from 30 October 2026).

## Licence

MIT, copyright Nikolaos Theodoropoulos (see LICENSE).
