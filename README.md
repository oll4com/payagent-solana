# PayAgent on Solana

An AI agent you pay per task. A policy gate decides before any work runs, the agent does the task and shows a preview, and
the full result unlocks only when the payment has settled on Solana: with **x402 on Solana devnet**, or **from Arbitrum or
Base through Aurora Intents**. Every step lands in a hash-chained audit log.

Entered in the Encode Club Solana Hackathon 2026 for two tracks: **Aurora Intents: Bring any-chain liquidity to Solana** and
**Best Use of x402 on Solana**.

- Live demo: https://payagent.oll4.com:4951/solana/ (x402 on Solana devnet; any-chain payments run on mainnet, see below)
- Slides: https://payagent.oll4.com:4951/solana/deck
- Source: this repository (MIT)

## What it does

1. **A policy gate** (`src/policy.js`). Every task gets AUTO (runs now), APPROVE (a reviewer must accept it first) or REFUSE,
   with the id of the rule that decided. Tasks up to 1 USDC and 1,000 characters run at once; larger ones wait for a reviewer
   (`POST /api/tasks/:id/review` with `x-review-token`); secrets and abuse are refused; prices outside 0.01-5 USDC are refused.
2. **Payment for the result on Solana.** The agent works first; the customer sees a short preview. The full result sits
   behind `GET /api/tasks/:id/result`, which pays out only after a settled payment:
   - **x402 on Solana devnet** (`src/x402-solana.js`): the route answers `402 Payment Required` with an `exact`
     requirement (network `solana-devnet`, devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, the task's price, the
     owner's address). The customer's wallet signs a USDC transfer; the PayAI facilitator verifies and settles it on Solana and
     pays the network fee; the transaction id goes into the audit log.
   - **Any chain through Aurora Intents** (`src/aurora.js`, `src/solana-check.js`): see below.
3. **A hash-chained audit log** (`src/audit.js`). Each entry carries the hash of the entry before it, so an edit or a deletion
   shows (`GET /api/audit` reports whether the chain verifies). Tasks appear in it only by a short hash, because a task id
   unlocks a paid result.

## How Solana powers it

The settlement is on Solana in both ways to pay. x402 makes a per-task price of one cent workable: the fee is a fraction of a
cent and the facilitator pays it, so the customer needs only USDC. Aurora Intents brings customers who hold USDC on Arbitrum or
Base to the same Solana settlement: they send to a deposit address, and the owner receives mainnet USDC on Solana.

```
customer ──task──▶ policy gate ──▶ agent (model) ──▶ preview
    │                                                   │
    ├─ x402: GET result ─▶ 402 ─▶ signed USDC transfer ─▶ PayAI facilitator ─▶ Solana devnet ─▶ settled ─▶ result
    │
    └─ Aurora: quote (deposit address on Arbitrum/Base) ─▶ customer deposits ─▶ NEAR Intents swap ─▶ USDC on Solana mainnet
                                                      status polled ─▶ SUCCESS ─▶ amounts match the quote?
                                                      ─▶ Solana RPC shows the credit? ─▶ result
                                                      INCOMPLETE_DEPOSIT / REFUNDED / FAILED ─▶ task stays payable, refund recorded
```

### Failed payments (x402)

A payment that does not match the task (amount, asset, network, receiver, a broken header) never reaches the facilitator: the
route answers a new `402` naming the reason, writes `PAYMENT_REFUSED` to the audit log, and the task stays payable. A payment
the facilitator cannot verify or settle is refused the same way. `scripts/demo-devnet.sh` shows it: it signs a payment for 1
base unit instead of the price, the server refuses it, then the right payment unlocks the result.

### Cross-chain payments and refunds (Aurora Intents)

For a task, `POST /api/tasks/:id/aurora-quote {origin, refundTo, minutes}` asks Aurora's Swap API for a `FLEX_INPUT` quote
that turns USDC on Arbitrum, Base, Ethereum, Optimism, Polygon or Avalanche into USDC on Solana for the owner, and returns the deposit address, the amount to send,
the minimum deposit (`minAmountIn`), the minimum the owner will receive (`minAmountOut`), the refund address and the deadline
(the one asked: Aurora's own answer adds 72 hours to the address's life). The customer sends USDC from any wallet or exchange.
`POST /api/tasks/:id/aurora-check` (the page calls it every 5 seconds; the server asks Aurora at most once per
`AURORA_RECHECK_MS`) follows the swap:

| Aurora status | What PayAgent does |
|---|---|
| `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING` | shows it; the task stays locked |
| `INCOMPLETE_DEPOSIT` | shows how much arrived against the minimum; the customer may send the difference before the deadline |
| `SUCCESS` | unlocks only if all of these hold: Aurora names the Solana transaction; the deposit is at least `minAmountIn`; the delivery is at least `minAmountOut`; and Solana (finalized, read from a public RPC) shows that transaction crediting at least `minAmountOut` of mainnet USDC to the owner's address. A mismatch keeps the task locked and writes `AURORA_SETTLEMENT_REJECTED`; an RPC that is unavailable or does not know the transaction yet is asked again |
| `REFUNDED`, `FAILED` | the quote, deposit, refunded amount, refund reason and refund transactions are kept in the task's history and the audit log; the task stays payable and may be quoted again |

A quote with a deposit in flight is never replaced (409), so a late payout cannot lose its task. Paying less than the minimum is
the way to see a refund: a 5 USDC task paid with 3 USDC is `INCOMPLETE_DEPOSIT`, then `REFUNDED` to the customer's address when
the quote closes, minus Aurora's refund fee.

**Aurora has no testnet** ("There is no public testnet deployment; test the complete flow on mainnet with small amounts",
Aurora's FAQ). The unit tests drive the whole logic against scripted Aurora and Solana answers, a dry quote and a live quote
(no deposit) run against the real API, and the real flow is run on mainnet with small deposits: `scripts/demo-aurora.mjs`.

## Run it on devnet

```
npm install
cp .env.example .env    # then fill in the addresses and keys it names
npm test                # unit tests; LIVE=1 node --env-file=.env --test test/devnet.live.test.js pays 0.01 devnet USDC
REVIEW_TOKEN=<24+ random characters> AGENT_MODE=echo node --env-file=.env src/server.js    # then open http://127.0.0.1:8787/
scripts/demo-devnet.sh http://127.0.0.1:8787 "Write a haiku about Solana" 10000
```

- The page (`public/`, served by the same server) submits a task, shows the policy verdict, the 402, and pays with the demo
  wallet (a devnet-only key in `DEVNET_PAYER_KEY`, holding worthless devnet USDC) or from another chain.
- `AGENT_MODE=echo` answers with a test echo; for a real model set `AGENT_API_URL` (an OpenAI-compatible `/v1` base),
  `AGENT_API_KEY` and `AGENT_MODEL`, and `AGENT_DAILY_TOKENS` to cap the day's spend.
- The demo wallet needs devnet USDC (https://faucet.circle.com, Solana Devnet) and no SOL: the facilitator pays the fee.
  `scripts/devnet-pay.mjs <result URL>` is the same wallet as a command, an example x402 client for any route.
- Aurora (optional): an API key from https://studio.aurora.dev as `AURORA_API_KEY`, and `SOLANA_RECEIVE_ADDRESS`, the owner's
  mainnet Solana address (a public address; no key of the owner's is ever on the server). Then
  `scripts/aurora-dry-quote.mjs` prices a payment without reserving anything, and
  `REVIEW_TOKEN=... node scripts/demo-aurora.mjs <server> <price in USDC> <arbitrum|base> <your refund address> [minutes]`
  follows one payment to its end. It moves real USDC: use a small amount.
- Docker: `docker build -t payagent-solana .` (two stages, non-root, `/data` volume); give it the same variables with `--env-file`.
  Behind a reverse proxy serving it under a path, set `BASE_PATH=/solana` and `TRUST_PROXY=1`.

### Settings (environment)

| Variable | Meaning |
|---|---|
| `DEVNET_RECEIVER_ADDRESS` | owner's devnet address that x402 payments go to (required) |
| `SOLANA_RECEIVE_ADDRESS`, `AURORA_API_KEY` | owner's mainnet Solana address and Aurora key; both set turns the Aurora flow on |
| `DEVNET_PAYER_KEY` | the page's demo wallet, a devnet-only key (unset: no one-click button) |
| `SOLANA_RPC_URL` | RPC for the settlement check (default the public mainnet RPC, which rate-limits: the check just retries) |
| `REVIEW_TOKEN` | secret of 24+ characters for the reviewer routes (required) |
| `MIN_PRICE`, `AUTO_MAX_PRICE`, `MAX_PRICE`, `AUTO_MAX_CHARS` | policy limits in USDC base units / characters |
| `TASKS_PER_IP_HOUR`, `TASKS_PER_DAY`, `TRUST_PROXY` | public-demo rate limits |
| `AGENT_*` | the model: `AGENT_API_URL`, `AGENT_API_KEY`, `AGENT_MODEL`, `AGENT_REASONING_EFFORT`, `AGENT_MAX_TOKENS`, `AGENT_DAILY_TOKENS` |
| `AURORA_RECHECK_MS`, `BASE_PATH`, `PORT`, `DATA_DIR`, `REPO_URL` | polling interval, path prefix, listening port, data folder, source link |

## Tests

`npm test` runs 27 tests with no network: the policy and audit chain, x402 requirements and payments through a scripted
facilitator (matching, mismatched and unsettled payments), the Aurora client on a recorded real dry quote, the settlement
rules above (underpaid deposit refunded, SUCCESS with amounts below the quote rejected, delivery not yet visible on Solana,
Solana credit below the minimum, a deposit in flight blocking a new quote), the Solana credit parser (also checked against real
mainnet payout transactions), the demo wallet route, the security headers and `BASE_PATH`.
`test/devnet.live.test.js` (`LIVE=1`) settles a real devnet payment.

## Security notes

- The server holds no key of the owner's. The only secret keys are the Aurora API key (a path segment of Aurora's API: errors
  name the route, never the key) and a devnet-only demo key.
- Strict CSP (no inline script or style), `nosniff`, no referrer, no framing; the pages are a fixed list of files.
- Task ids unlock paid results, so listing them needs the reviewer token and the audit log carries only short hashes.
- Public-demo limits: tasks per client per hour and per day, a daily token budget for the model, a refund address checked as an
  EVM address before any call to Aurora.

## Known limits

- Tasks are kept in one JSON file and the audit log in one file: a single instance, not a cluster.
- The settlement check reads Solana through a public RPC; a busy RPC delays an unlock but never allows a wrong one.
- If a deposit lands on the address of a quote that was already replaced (only possible after the quote expired with nothing
  deposited), Aurora still swaps it for the owner but the task no longer unlocks automatically.
- The one-click demo wallet exists so reviewers need no wallet; real customers use any x402 client with their own wallet.

## Prior work (disclosed)

These files come unchanged from [payagent](https://github.com/oll4com/payagent) (MIT, commit 8680441), built from
27 October 2026 for BCH BLAZE 2026:

- `src/policy.js`: the AUTO / APPROVE / REFUSE gate in front of the agent.
- `src/audit.js`: the append-only, hash-chained audit log.
- `src/agent.js`: the call to an OpenAI-compatible model endpoint.

The task flow and the HTTP server are adapted from it (the payment step is replaced). Everything about Solana, x402, Aurora
Intents, the settlement checks, the page and the demo scripts is new in this repository and built during the hackathon (from
30 October 2026).

## Licence

MIT, copyright Nikolaos Theodoropoulos (see LICENSE).
