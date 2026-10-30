import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from '@x402/core/http';
import { createX402, DEVNET, DEVNET_USDC } from '../src/x402-solana.js';

const payTo = 'HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16';
// PayAI's /supported answer for Solana devnet (30/10/2026); verify/settle answers are scripted per test.
function fakeFacilitator({ verify = { isValid: true, payer: 'Payer1111' }, settle = { success: true, transaction: '5sig', network: DEVNET, payer: 'Payer1111' } } = {}) {
  const calls = [];
  return { calls, facilitator: {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: DEVNET, extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' } }], extensions: [], signers: {} }),
    verify: async (p, r) => { calls.push(['verify', r.amount]); return verify; },
    settle: async (p, r) => { calls.push(['settle', r.amount]); return settle; }
  } };
}
const signed = (accepted) => encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { transaction: 'AQAB' } });

test('402 names devnet USDC, the owner and the price, with the facilitator as fee payer', async () => {
  const x402 = await createX402({ payTo, facilitator: fakeFacilitator().facilitator });
  const answer = await x402.paymentRequired({ amount: 50000, url: 'http://localhost/api/tasks/1/result', description: 'task result' });
  const [req] = answer.body.accepts;
  assert.equal(answer.status, 402);
  assert.deepEqual([req.scheme, req.network, req.asset, req.amount, req.payTo, req.extra.feePayer],
    ['exact', DEVNET, DEVNET_USDC, '50000', payTo, '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4']);
  assert.deepEqual(decodePaymentRequiredHeader(answer.headers['PAYMENT-REQUIRED']).accepts, answer.body.accepts);
});

test('a matching payment is verified, then settled, and returns the transaction', async () => {
  const { facilitator, calls } = fakeFacilitator();
  const x402 = await createX402({ payTo, facilitator });
  const [req] = (await x402.paymentRequired({ amount: 50000, url: 'u', description: 'd' })).body.accepts;
  const paid = await x402.pay({ amount: 50000, headerValue: signed(req) });
  assert.deepEqual([paid.ok, paid.transaction, paid.payer], [true, '5sig', 'Payer1111']);
  assert.ok(paid.headers['PAYMENT-RESPONSE']);
  assert.deepEqual(calls, [['verify', '50000'], ['settle', '50000']]);
});

test('a payment for another amount or a broken header never reaches the facilitator', async () => {
  const { facilitator, calls } = fakeFacilitator();
  const x402 = await createX402({ payTo, facilitator });
  const [cheap] = (await x402.paymentRequired({ amount: 1, url: 'u', description: 'd' })).body.accepts;
  assert.deepEqual(await x402.pay({ amount: 50000, headerValue: signed(cheap) }), { ok: false, reason: 'payment does not match this result' });
  assert.equal((await x402.pay({ amount: 50000, headerValue: 'not base64 json' })).ok, false);
  assert.equal(calls.length, 0);
});

test('an invalid or unsettled payment does not unlock the result', async () => {
  for (const [script, reason] of [[{ verify: { isValid: false, invalidReason: 'insufficient_funds' } }, 'insufficient_funds'],
    [{ settle: { success: false, errorReason: 'transaction_failed', transaction: '', network: DEVNET } }, 'transaction_failed']]) {
    const x402 = await createX402({ payTo, facilitator: fakeFacilitator(script).facilitator });
    const [req] = (await x402.paymentRequired({ amount: 50000, url: 'u', description: 'd' })).body.accepts;
    const paid = await x402.pay({ amount: 50000, headerValue: signed(req) });
    assert.deepEqual([paid.ok, paid.reason], [false, reason]);
  }
});

test('the owner address and the amount are checked before any call', async () => {
  await assert.rejects(createX402({ payTo: '0xabc', facilitator: fakeFacilitator().facilitator }), /payTo/);
  const x402 = await createX402({ payTo, facilitator: fakeFacilitator().facilitator });
  await assert.rejects(x402.paymentRequired({ amount: '0.5', url: 'u', description: 'd' }), /amount/);
});
