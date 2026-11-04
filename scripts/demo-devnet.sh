#!/usr/bin/env bash
# The whole devnet flow against a running server, one step per line, for reviewers and the demo video:
#   scripts/demo-devnet.sh http://127.0.0.1:8787 "Write a haiku about Solana" 10000
# Needs node, curl and DEVNET_PAYER_KEY (the customer's devnet wallet) in .env. 10000 = 0.01 devnet USDC.
set -euo pipefail
base=${1:?server URL}; description=${2:?task text}; price=${3:-10000}
cd "$(dirname "$0")/.."
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d);console.log(eval(process.argv[1]))})' "$1"; }

echo "1. Submit the task (price $price USDC base units)"
task=$(curl -sf "$base/api/tasks" -H 'content-type: application/json' -d "$(node -e 'console.log(JSON.stringify({description:process.argv[1],price:Number(process.argv[2])}))' "$description" "$price")")
id=$(echo "$task" | json v.id)
echo "$task" | json '`   policy: ${v.ruleId} -> ${v.status}; preview: ${(v.preview??"").slice(0,120)}`'
[ "$(echo "$task" | json v.status)" = AWAITING_PAYMENT ] || { echo "   the task is not payable yet (held for a reviewer, refused or failed)"; exit 1; }

echo "2. Ask for the result without paying"
curl -s -o /dev/null -w '   HTTP %{http_code} (402 = Payment Required with an x402 exact requirement on solana-devnet)\n' "$base/api/tasks/$id/result"

echo "3. A payment for 1 base unit instead of the price is refused, and the task stays payable"
node --env-file=.env scripts/devnet-pay.mjs "$base/api/tasks/$id/result" --underpay

echo "4. Pay the right amount with the customer's devnet wallet (x402, settled by the PayAI facilitator)"
node --env-file=.env scripts/devnet-pay.mjs "$base/api/tasks/$id/result"

echo "5. The task now"
curl -sf "$base/api/tasks/$id" | json '`   ${v.status} via ${v.paidWith}; transaction ${v.transaction}\n   result: ${v.result}`'

echo "6. The audit log"
curl -sf "$base/api/audit" | json '`   chain verified: ${v.verified.ok}\n` + v.entries.map(e => `   ${e.at ?? ""} ${e.status} ${e.ruleId ?? e.paidWith ?? ""}`).join("\n")'
