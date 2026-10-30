// node --env-file=.env scripts/devnet-pay.mjs <url>: the demo's customer wallet. Fetches a paid result, answers its 402 with a
// devnet USDC payment signed by DEVNET_PAYER_KEY (the facilitator pays the network fee), and prints the settlement.
import { x402Client } from '@x402/core/client';
import { x402HTTPClient } from '@x402/core/http';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { toClientSvmSigner } from '@x402/svm';
import { createKeyPairSignerFromBytes, getBase58Encoder } from '@solana/kit';
import { DEVNET } from '../src/x402-solana.js';

export async function payUrl(url, { payerKey = process.env.DEVNET_PAYER_KEY, fetch = globalThis.fetch } = {}) {
  if (!payerKey) throw new Error('DEVNET_PAYER_KEY is not set');
  const signer = toClientSvmSigner(await createKeyPairSignerFromBytes(getBase58Encoder().encode(payerKey.trim())));
  const client = new x402HTTPClient(registerExactSvmScheme(new x402Client(), { signer, networks: [DEVNET] }));
  const first = await fetch(url);
  if (first.status !== 402) return { status: first.status, body: await first.json().catch(() => null), paid: false };
  const required = client.getPaymentRequiredResponse((name) => first.headers.get(name), await first.json());
  const payload = await client.createPaymentPayload(required);
  const paid = await fetch(url, { headers: client.encodePaymentSignatureHeader(payload) });
  const settlement = paid.ok ? client.getPaymentSettleResponse((name) => paid.headers.get(name)) : null;
  return { status: paid.status, body: await paid.json().catch(() => null), paid: paid.ok, payer: signer.address, settlement };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await payUrl(process.argv[2]);
  console.log(JSON.stringify({ status: result.status, paid: result.paid, payer: result.payer, transaction: result.settlement?.transaction,
    explorer: result.settlement?.transaction ? `https://explorer.solana.com/tx/${result.settlement.transaction}?cluster=devnet` : undefined }, null, 2));
}
