// Pay a task's result with x402 on Solana devnet: the result route answers 402 with an `exact` requirement (devnet USDC to
// the owner's address), the customer's wallet signs a transfer, and a facilitator (PayAI by default, no API key) verifies
// and submits it; the result unlocks only on a settled transaction.
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { ExactSvmScheme } from '@x402/svm/exact/server';

export const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const PAYAI = 'https://facilitator.payai.network';

export async function createX402({ payTo, facilitator = new HTTPFacilitatorClient({ url: PAYAI }), maxTimeoutSeconds = 120 }) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo ?? '')) throw new Error('payTo must be a Solana address');
  const server = new x402ResourceServer(facilitator).register(DEVNET, new ExactSvmScheme());
  await server.initialize();
  const requirementsFor = async (amount) => {
    if (!/^[1-9]\d{0,12}$/.test(String(amount))) throw new Error('amount must be a positive integer of USDC base units');
    return server.buildPaymentRequirements({ scheme: 'exact', network: DEVNET, payTo, maxTimeoutSeconds,
      price: { asset: DEVNET_USDC, amount: String(amount) } });
  };
  return {
    // The 402 answer for a result of `amount` USDC base units: header for x402 clients, the same object as the body.
    async paymentRequired({ amount, url, description }, error) {
      const required = await server.createPaymentRequiredResponse(await requirementsFor(amount), { url, description, mimeType: 'application/json' }, error);
      return { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) }, body: required };
    },
    // headerValue: the request's PAYMENT-SIGNATURE. Settled only when it pays exactly this result's requirement.
    async pay({ amount, headerValue }) {
      let payload;
      try { payload = decodePaymentSignatureHeader(headerValue); } catch { return { ok: false, reason: 'malformed payment header' }; }
      const requirements = server.findMatchingRequirements(await requirementsFor(amount), payload);
      if (!requirements) return { ok: false, reason: 'payment does not match this result' };
      const verified = await server.verifyPayment(payload, requirements);
      if (!verified.isValid) return { ok: false, reason: verified.invalidReason ?? 'payment not valid', payer: verified.payer };
      const settled = await server.settlePayment(payload, requirements);
      if (!settled.success) return { ok: false, reason: settled.errorReason ?? 'settlement failed', payer: settled.payer };
      return { ok: true, transaction: settled.transaction, payer: settled.payer, network: settled.network,
        headers: { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settled) } };
    }
  };
}
