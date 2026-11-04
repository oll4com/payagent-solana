import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAurora, ORIGINS, SOLANA_USDC } from '../src/aurora.js';

// A real dry quote from intents-api.aurora.dev (30/10/2026, 2.8 USDC Arbitrum -> Solana); a live quote adds depositAddress and deadline.
const dryQuote = JSON.parse(readFileSync(new URL('./fixtures/aurora-quote-dry.json', import.meta.url)));
const recipient = 'HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16';
const refundTo = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

function fakeFetch(answer, status = 200) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status, json: async () => answer }; };
  return { fetch, calls };
}

test('quote asks a FLEX_INPUT swap into Solana USDC for the owner and returns the band', async () => {
  const { fetch, calls } = fakeFetch(dryQuote);
  const q = await createAurora({ apiKey: 'k', fetch }).quote({ origin: 'arbitrum', amount: 2800000, recipient, refundTo, dry: true, now: 0 });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://intents-api.aurora.dev/api/quote/k');
  assert.deepEqual([sent.swapType, sent.originAsset, sent.destinationAsset, sent.recipient, sent.refundType, sent.amount],
    ['FLEX_INPUT', ORIGINS.arbitrum, SOLANA_USDC, recipient, 'ORIGIN_CHAIN', '2800000']);
  assert.equal(sent.deadline, '1970-01-01T02:00:00.000Z');
  assert.deepEqual([q.amountIn, q.minAmountIn, q.amountOut, q.depositAddress], ['2800000', '2772000', '2789421', null]);
});

test('a live quote without a deposit address is an error, not a payable task', async () => {
  const { fetch } = fakeFetch(dryQuote);
  await assert.rejects(createAurora({ apiKey: 'k', fetch }).quote({ origin: 'base', amount: 1, recipient, refundTo }), /no deposit address/);
});

test('bad inputs never reach Aurora', async () => {
  const { fetch, calls } = fakeFetch(dryQuote);
  const aurora = createAurora({ apiKey: 'k', fetch });
  await assert.rejects(aurora.quote({ origin: 'bitcoin', amount: 1, recipient, refundTo }), /origin/);
  await assert.rejects(aurora.quote({ origin: 'base', amount: '1.5', recipient, refundTo }), /amount/);
  await assert.rejects(aurora.quote({ origin: 'base', amount: 1, recipient: refundTo, refundTo }), /recipient/);
  await assert.rejects(aurora.quote({ origin: 'base', amount: 1, recipient, refundTo: recipient }), /refundTo/);
  assert.equal(calls.length, 0);
});

test('errors name the route and never the key', async () => {
  const { fetch } = fakeFetch({ message: 'Unauthorized' }, 401);
  const error = await createAurora({ apiKey: 'secret-key-value', fetch }).status('0xabc').catch((e) => e);
  assert.match(error.message, /Aurora status answered 401: Unauthorized/);
  assert.doesNotMatch(error.message, /secret-key-value/);
});

test('status reads the swap: final only on SUCCESS, REFUNDED or FAILED', async () => {
  const success = { status: 'SUCCESS', swapDetails: { depositedAmount: '2800000', amountOut: '2789421',
    destinationChainTxHashes: [{ hash: '5Xy', explorerUrl: 'https://solscan.io/tx/5Xy' }] } };
  const { fetch, calls } = fakeFetch(success);
  const s = await createAurora({ apiKey: 'k', fetch }).status('0xDeposit');
  assert.equal(calls[0].url, 'https://intents-api.aurora.dev/api/status/k?depositAddress=0xDeposit');
  assert.deepEqual(s, { status: 'SUCCESS', final: true, deposited: '2800000', amountOut: '2789421', destinationTx: '5Xy', refunded: null, refundReason: null, originTxs: [] });
  const pending = await createAurora({ apiKey: 'k', fetch: fakeFetch({ status: 'PENDING_DEPOSIT' }).fetch }).status('0xDeposit');
  assert.equal(pending.final, false);
});

test('a refunded swap reports the amount, the reason and the origin-chain transactions', async () => {
  const refunded = { status: 'REFUNDED', swapDetails: { depositedAmount: '3000000', refundedAmount: '2994700', refundReason: 'PARTIAL_DEPOSIT',
    originChainTxHashes: [{ hash: '0xdep', explorerUrl: 'https://arbiscan.io/tx/0xdep', extra: 'ignored' }, { hash: '0xref', explorerUrl: 'https://arbiscan.io/tx/0xref' }] } };
  const s = await createAurora({ apiKey: 'k', fetch: fakeFetch(refunded).fetch }).status('0xDeposit');
  assert.deepEqual([s.status, s.final, s.refunded, s.refundReason, s.destinationTx], ['REFUNDED', true, '2994700', 'PARTIAL_DEPOSIT', null]);
  assert.deepEqual(s.originTxs.map((t) => t.hash), ['0xdep', '0xref']);
  assert.deepEqual(Object.keys(s.originTxs[0]), ['hash', 'explorerUrl']);
});

test('a live quote reports the deadline that was asked, not the 72 h Aurora adds to the deposit address', async () => {
  const answer = { correlationId: 'c', quote: { ...dryQuote.quote, depositAddress: '0xDep', deadline: '1970-01-04T02:00:00.000Z', timeWhenInactive: '1970-01-04T02:00:00.000Z', refundFee: '5300' } };
  const q = await createAurora({ apiKey: 'k', fetch: fakeFetch(answer).fetch }).quote({ origin: 'base', amount: 3000000, recipient, refundTo, minutes: 15, now: 0 });
  assert.deepEqual([q.deadline, q.activeUntil, q.refundFee, q.depositAddress], ['1970-01-01T00:15:00.000Z', '1970-01-04T02:00:00.000Z', '5300', '0xDep']);
  const { fetch, calls } = fakeFetch(answer);
  for (const minutes of [0, 9, 241, 1.5, '15']) await assert.rejects(createAurora({ apiKey: 'k', fetch }).quote({ origin: 'base', amount: 1, recipient, refundTo, minutes }), /minutes/);
  assert.equal(calls.length, 0);
});
