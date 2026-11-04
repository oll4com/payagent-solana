// The demo's customer wallet: a devnet-only keypair (holding worthless devnet USDC) that signs x402 payments, so reviewers can
// pay a task with one click. Any x402 client does the same against the same route (scripts/devnet-pay.mjs is one).
import { x402Client } from '@x402/core/client';
import { x402HTTPClient } from '@x402/core/http';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { toClientSvmSigner } from '@x402/svm';
import { createKeyPairSignerFromBytes, getBase58Encoder } from '@solana/kit';
import { DEVNET } from './x402-solana.js';

export async function createDemoWallet(payerKey) {
  if (!payerKey) throw new Error('DEVNET_PAYER_KEY is not set');
  const signer = toClientSvmSigner(await createKeyPairSignerFromBytes(getBase58Encoder().encode(payerKey.trim())));
  const client = new x402HTTPClient(registerExactSvmScheme(new x402Client(), { signer, networks: [DEVNET] }));
  return {
    address: signer.address,
    // `answer`: a 402 as the service returns it ({ headers, body }); gives the headers that pay it.
    async paymentHeaders(answer) {
      const headers = new Headers(answer.headers);
      const required = client.getPaymentRequiredResponse((name) => headers.get(name), answer.body);
      return client.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
    },
    client
  };
}
