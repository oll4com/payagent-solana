// node --env-file=.env scripts/devnet-pay.mjs <url>: the demo's customer wallet. Fetches a paid result, answers its 402 with a
// devnet USDC payment signed by DEVNET_PAYER_KEY (the facilitator pays the network fee), and prints the settlement.
import { createDemoWallet } from '../src/demo-wallet.js';

export async function payUrl(url, { payerKey = process.env.DEVNET_PAYER_KEY, fetch = globalThis.fetch } = {}) {
  const wallet = await createDemoWallet(payerKey);
  const first = await fetch(url);
  if (first.status !== 402) return { status: first.status, body: await first.json().catch(() => null), paid: false };
  const paid = await fetch(url, { headers: await wallet.paymentHeaders({ headers: first.headers, body: await first.json() }) });
  const settlement = paid.ok ? wallet.client.getPaymentSettleResponse((name) => paid.headers.get(name)) : null;
  return { status: paid.status, body: await paid.json().catch(() => null), paid: paid.ok, payer: wallet.address, settlement };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await payUrl(process.argv[2]);
  console.log(JSON.stringify({ status: result.status, paid: result.paid, payer: result.payer, transaction: result.settlement?.transaction,
    explorer: result.settlement?.transaction ? `https://explorer.solana.com/tx/${result.settlement.transaction}?cluster=devnet` : undefined }, null, 2));
}
