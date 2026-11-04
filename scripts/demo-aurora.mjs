// Pay one task from another chain through Aurora Intents and follow it to its end (mainnet, real USDC), one line per status change:
//   REVIEW_TOKEN=... node scripts/demo-aurora.mjs <server url> <price in USDC> <arbitrum|base> <your refund address> [minutes] ["task text"]
// Paid in full: the task unlocks. Pay less than the quote's minimum (e.g. a 5 USDC task, 3 USDC sent): the swap fails and Aurora
// refunds to your address when the quote closes. Prices above 1 USDC wait for a reviewer; REVIEW_TOKEN approves them.
const [server, price, origin, refundTo, minutes = '120', text = 'Explain in three sentences why a per-task payment from any chain suits an AI agent.'] = process.argv.slice(2);
if (!refundTo) { console.error('usage: demo-aurora.mjs <server url> <price in USDC> <arbitrum|base> <refund address> [minutes] ["task text"]'); process.exit(2); }
const usdc = (units) => String(Number(units) / 1e6);
const api = async (path, method = 'GET', body, headers = {}) => {
  const response = await fetch(`${server.replace(/\/$/, '')}/api/${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${json.error}`);
  return json;
};
const log = (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

let task = await api('tasks', 'POST', { description: text, price: Math.round(Number(price) * 1e6) });
log(`task ${task.ref}: ${task.status} (${task.ruleId})`);
if (task.status === 'NEEDS_APPROVAL' && process.env.REVIEW_TOKEN) {
  task = await api(`tasks/${task.id}/review`, 'POST', { approve: true, reviewer: 'demo script' }, { 'x-review-token': process.env.REVIEW_TOKEN });
  log(`approved by the reviewer: ${task.status}`);
}
if (task.status !== 'AWAITING_PAYMENT') throw new Error(`the task is ${task.status}; it cannot be paid yet`);
task = await api(`tasks/${task.id}/aurora-quote`, 'POST', { origin, refundTo, minutes: Number(minutes) });
const a = task.aurora;
log(`SEND USDC on ${origin} to ${a.depositAddress}`);
log(`  quote: ${usdc(a.amountIn)} USDC (at least ${usdc(a.minAmountIn)}) -> the owner gets at least ${usdc(a.minAmountOut)} USDC on Solana; open until ${a.deadline}; refunds to ${a.refundTo}`);

let last = '';
for (;;) {
  task = await api(`tasks/${task.id}/aurora-check`, 'POST');
  const now = task.aurora;
  const line = task.status === 'PAID' ? 'PAID' : now ? `${now.status}${now.deposited ? ` deposited ${usdc(now.deposited)}` : ''}${now.problem ? ` PROBLEM ${now.problem}` : ''}` : `ended: ${task.auroraHistory.at(-1).status}`;
  if (line !== last) { log(line); last = line; }
  if (task.status === 'PAID') {
    log(`unlocked: ${task.result}`);
    log(`delivered on Solana: https://solscan.io/tx/${task.transaction} (credited ${usdc(task.auroraSettled.credited ?? task.auroraSettled.amountOut)} USDC to the owner)`);
    break;
  }
  if (!now) {
    const h = task.auroraHistory.at(-1);
    log(`${h.status}: ${usdc(h.refunded)} USDC returned to ${h.refundTo}${h.refundReason ? ` (reason ${h.refundReason})` : ''}; the task is still payable`);
    for (const tx of h.originTxs ?? []) log(`  ${tx.explorerUrl}`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
const audit = await api('audit');
log(`audit chain verified: ${audit.verified.ok}`);
