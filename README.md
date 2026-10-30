# PayAgent on Solana

An AI agent paid per task on Solana: a policy gate decides before any work runs, the customer pays the task with x402 on
Solana devnet or from any chain through Aurora Intents, and every step lands in a hash-chained audit log.

Entry for the Encode Club Solana Hackathon 2026 (Aurora Intents track). Work in progress: see the build plan in the
hackathon folder. Nothing here is deployed yet.

## Prior work (disclosed)

These files come unchanged from [payagent](https://github.com/oll4com/payagent) (MIT, commit 8680441), built from
27 October 2026 for BCH BLAZE 2026:

- `src/policy.js`: the AUTO / APPROVE / REFUSE gate in front of the agent.
- `src/audit.js`: the append-only, hash-chained audit log.
- `src/agent.js`: the call to an OpenAI-compatible model endpoint.

Everything about Solana and Aurora Intents is new in this repository and built during the hackathon (from 30 October 2026).

## Licence

MIT, copyright INTRATRADE SINGLE MEMBER P.C.
