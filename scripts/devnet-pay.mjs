// node --env-file=.env scripts/devnet-pay.mjs <url> [--underpay]: the demo's customer wallet. Fetches a paid result, answers its 402 with a
// devnet USDC payment signed by DEVNET_PAYER_KEY (the facilitator pays the network fee), and prints the settlement.
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { createDemoWallet } from '../src/demo-wallet.js';

// underpay: sign a payment for 1 base unit of USDC instead of the price, to show the server refuses it (nothing is sent on-chain).
export async function payUrl(url, { payerKey = process.env.DEVNET_PAYER_KEY, fetch = globalThis.fetch, underpay = false } = {}) {
  const wallet = await createDemoWallet(payerKey);
  const first = await fetch(url);
  if (first.status !== 402) return { status: first.status, body: await first.json().catch(() => null), paid: false };
  const required = await first.json();
  if (underpay) for (const accepted of required.accepts) accepted.amount = '1';
  const paid = await fetch(url, { headers: await wallet.paymentHeaders({ headers: underpay ? { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) } : first.headers, body: required }) });
  const settlement = paid.ok ? wallet.client.getPaymentSettleResponse((name) => paid.headers.get(name)) : null;
  return { status: paid.status, body: await paid.json().catch(() => null), paid: paid.ok, payer: wallet.address, settlement };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const underpay = process.argv.includes('--underpay');
  const result = await payUrl(process.argv[2], { underpay });
  console.log(JSON.stringify({ status: result.status, paid: result.paid, payer: result.payer, refusedBecause: result.paid ? undefined : result.body?.error, transaction: result.settlement?.transaction,
    explorer: result.settlement?.transaction ? `https://explorer.solana.com/tx/${result.settlement.transaction}?cluster=devnet` : undefined }, null, 2));
}
