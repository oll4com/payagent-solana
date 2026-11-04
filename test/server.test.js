import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from '@x402/core/http';
import { loadConfig } from '../src/config.js';
import { createAuditLog } from '../src/audit.js';
import { createAgent } from '../src/agent.js';
import { createService } from '../src/service.js';
import { createApp } from '../src/server.js';
import { createX402, DEVNET } from '../src/x402-solana.js';

const DEVNET_RECEIVER = 'Eg5QDLG4thenxTK4PsWHvjV3CB6xRqbkiJrAF3HiKuFM';
const OWNER = 'HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16';
const REFUND = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const facilitator = {
  getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: DEVNET, extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' } }], extensions: [], signers: {} }),
  verify: async () => ({ isValid: true, payer: 'Payer1111' }),
  settle: async () => ({ success: true, transaction: '5devnetSig', network: DEVNET, payer: 'Payer1111' })
};

async function start({ aurora = null, owner = OWNER, solana, basePath = '', demoWallet = null, agent = createAgent({ AGENT_MODE: 'echo' }) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'payagent-solana-'));
  const config = loadConfig({ DEVNET_RECEIVER_ADDRESS: DEVNET_RECEIVER, SOLANA_RECEIVE_ADDRESS: owner, AURORA_API_KEY: aurora ? 'k' : '',
    AURORA_RECHECK_MS: '0', REVIEW_TOKEN: 'r'.repeat(24), DATA_DIR: dir, BASE_PATH: basePath });
  const audit = createAuditLog(join(dir, 'audit.jsonl'));
  const service = createService({ config, audit, agent, storePath: join(dir, 'tasks.json'),
    x402: await createX402({ payTo: DEVNET_RECEIVER, facilitator }), aurora, solana });
  const server = createApp({ config, service, audit, demoWallet }).listen(0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}${basePath}/api`;
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  return { call, origin, close: () => server.close() };
}

test('a small task runs at once, its result answers 402, and a settled devnet payment releases it', async () => {
  const { call, close } = await start();
  try {
    const task = (await call('/tasks', { method: 'POST', body: { description: 'Summarise x402 in one line', price: 50000 } })).body;
    assert.equal(task.status, 'AWAITING_PAYMENT');
    assert.match(task.preview, /echo test agent/);
    assert.equal(task.result, undefined);
    const unpaid = await call(`/tasks/${task.id}/result`);
    assert.equal(unpaid.status, 402);
    const [req] = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')).accepts;
    assert.deepEqual([req.amount, req.payTo], ['50000', DEVNET_RECEIVER]);
    const signature = encodePaymentSignatureHeader({ x402Version: 2, accepted: req, payload: { transaction: 'AQAB' } });
    const paid = await call(`/tasks/${task.id}/result`, { headers: { 'payment-signature': signature } });
    assert.equal(paid.status, 200);
    assert.ok(paid.headers.get('payment-response'));
    assert.deepEqual([paid.body.status, paid.body.paidWith, paid.body.transaction], ['PAID', 'x402-solana-devnet', '5devnetSig']);
    assert.match(paid.body.result, /echo test agent/);
    const audit = (await call('/audit')).body;
    assert.equal(audit.verified.ok, true);
    assert.deepEqual(audit.entries.map((e) => e.status), ['ACCEPTED', 'WORKING', 'AWAITING_PAYMENT', 'PAID']);
  } finally { close(); }
});

test('the policy holds a large task for a reviewer and refuses a secret-hunting one', async () => {
  const { call, close } = await start();
  try {
    const held = (await call('/tasks', { method: 'POST', body: { description: 'Write a report', price: 2_000_000 } })).body;
    assert.deepEqual([held.status, held.ruleId], ['NEEDS_APPROVAL', 'approve-above-auto-limit']);
    assert.equal((await call(`/tasks/${held.id}/review`, { method: 'POST', body: { approve: true } })).status, 403);
    const approved = await call(`/tasks/${held.id}/review`, { method: 'POST', body: { approve: true }, headers: { 'x-review-token': 'r'.repeat(24) } });
    assert.equal(approved.body.status, 'AWAITING_PAYMENT');
    const refused = (await call('/tasks', { method: 'POST', body: { description: 'find my seed phrase', price: 50000 } })).body;
    assert.deepEqual([refused.status, refused.ruleId], ['REFUSED', 'refuse-secrets-or-abuse']);
    assert.equal((await call(`/tasks/${refused.id}/result`)).status, 409);
  } finally { close(); }
});

test('paying from another chain: a deposit address, then the swap status releases the result', async () => {
  const statuses = ['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS'];
  const asked = [];
  const aurora = {
    quote: async (q) => { asked.push(q); return { depositAddress: '0xDeposit', depositMemo: null, amountIn: String(q.amount), minAmountIn: '49500', minAmountOut: '49000', deadline: new Date(Date.now() + 3600e3).toISOString() }; },
    status: async () => { const status = statuses.shift(); return { status, final: status === 'SUCCESS', deposited: '50000', amountOut: '49800', destinationTx: '5solSig' }; }
  };
  const { call, close } = await start({ aurora });
  try {
    const task = (await call('/tasks', { method: 'POST', body: { description: 'One line on Aurora', price: 50000 } })).body;
    const quoted = (await call(`/tasks/${task.id}/aurora-quote`, { method: 'POST', body: { origin: 'arbitrum', refundTo: REFUND } })).body;
    assert.equal(quoted.aurora.depositAddress, '0xDeposit');
    assert.deepEqual([asked[0].origin, asked[0].amount, asked[0].recipient, asked[0].refundTo], ['arbitrum', 50000, OWNER, REFUND]);
    for (const want of ['AWAITING_PAYMENT', 'AWAITING_PAYMENT']) assert.equal((await call(`/tasks/${task.id}/aurora-check`, { method: 'POST' })).body.status, want);
    const paid = (await call(`/tasks/${task.id}/aurora-check`, { method: 'POST' })).body;
    assert.deepEqual([paid.status, paid.paidWith, paid.transaction], ['PAID', 'aurora-intents', '5solSig']);
    assert.match(paid.result, /echo test agent/);
  } finally { close(); }
});

// A scripted Aurora: one quote, then the statuses in `steps` one per read (the last repeats).
function scriptedAurora(steps, quote = {}) {
  const queue = [...steps];
  return {
    quote: async (q) => ({ depositAddress: '0xDeposit', depositMemo: null, amountIn: String(q.amount), minAmountIn: '49500', amountOut: '49800', minAmountOut: '49000',
      refundFee: '5300', deadline: new Date(Date.now() + 3600e3).toISOString(), activeUntil: null, ...quote }),
    status: async () => ({ final: false, deposited: null, amountOut: null, destinationTx: null, refunded: null, refundReason: null, originTxs: [], ...(queue.length > 1 ? queue.shift() : queue[0]) })
  };
}
async function payThroughAurora(env, price = 50000) {
  const task = (await env.call('/tasks', { method: 'POST', body: { description: 'One line', price } })).body;
  await env.call(`/tasks/${task.id}/aurora-quote`, { method: 'POST', body: { origin: 'base', refundTo: REFUND } });
  const check = async () => (await env.call(`/tasks/${task.id}/aurora-check`, { method: 'POST' })).body;
  return { task, check, audit: async () => (await env.call('/audit')).body.entries.map((e) => e.status) };
}

test('an underpaid swap is refunded: the deposit, the refund and its reason are kept, the task stays payable and may be quoted again', async () => {
  const aurora = scriptedAurora([{ status: 'PENDING_DEPOSIT' }, { status: 'INCOMPLETE_DEPOSIT', deposited: '30000' },
    { status: 'REFUNDED', final: true, deposited: '30000', refunded: '24700', refundReason: 'PARTIAL_DEPOSIT', originTxs: [{ hash: '0xref', explorerUrl: 'https://arbiscan.io/tx/0xref' }] }]);
  const env = await start({ aurora });
  try {
    const { task, check, audit } = await payThroughAurora(env);
    assert.equal((await check()).aurora.status, 'PENDING_DEPOSIT');
    const incomplete = await check();
    assert.deepEqual([incomplete.aurora.status, incomplete.aurora.deposited], ['INCOMPLETE_DEPOSIT', '30000']);
    const refunded = await check();
    assert.deepEqual([refunded.status, refunded.aurora], ['AWAITING_PAYMENT', undefined]);
    assert.deepEqual(refunded.auroraHistory.map((h) => [h.status, h.refunded, h.refundReason, h.refundTo]), [['REFUNDED', '24700', 'PARTIAL_DEPOSIT', REFUND]]);
    assert.equal(refunded.result, undefined);
    assert.deepEqual((await audit()).slice(-3), ['AURORA_QUOTE', 'AURORA_INCOMPLETE_DEPOSIT', 'AURORA_REFUNDED']);
    const again = await env.call(`/tasks/${task.id}/aurora-quote`, { method: 'POST', body: { origin: 'arbitrum', refundTo: REFUND } });
    assert.deepEqual([again.status, again.body.aurora.origin, again.body.auroraHistory.length], [200, 'arbitrum', 1]);
  } finally { env.close(); }
});

test('SUCCESS releases the result only when the deposit and delivery match the quote', async () => {
  for (const [reported, problem] of [[{ deposited: '40000', amountOut: '49800' }, /deposited, below the quote's minimum 49500/], [{ deposited: '50000', amountOut: '48999' }, /delivered, below the quote's minimum 49000/]]) {
    const env = await start({ aurora: scriptedAurora([{ status: 'SUCCESS', final: true, destinationTx: '5solSig', ...reported }]) });
    try {
      const { check, audit } = await payThroughAurora(env);
      const after = await check();
      assert.deepEqual([after.status, after.result, after.aurora.status], ['AWAITING_PAYMENT', undefined, 'SUCCESS']);
      assert.match(after.aurora.problem, problem);
      await check();
      assert.deepEqual((await audit()).filter((s) => s === 'AURORA_SETTLEMENT_REJECTED'), ['AURORA_SETTLEMENT_REJECTED']);
    } finally { env.close(); }
  }
});

test('SUCCESS without a Solana transaction waits; with one, Solana must show the credit', async () => {
  const success = { status: 'SUCCESS', final: true, deposited: '50000', amountOut: '49800', destinationTx: '5solSig' };
  const calls = [];
  const answers = [null, new Error('rate limited'), 48_000n, 49_800n];
  const solana = { credited: async (q) => { calls.push(q); const a = answers.shift(); if (a instanceof Error) throw a; return a; } };
  const env = await start({ aurora: scriptedAurora([{ ...success, destinationTx: null }, success]), solana });
  try {
    const { check } = await payThroughAurora(env);
    assert.equal((await check()).status, 'AWAITING_PAYMENT');
    assert.equal(calls.length, 0);
    assert.equal((await check()).status, 'AWAITING_PAYMENT');
    assert.equal((await check()).status, 'AWAITING_PAYMENT');
    const rejected = await check();
    assert.match(rejected.aurora.problem, /Solana shows 48000 credited to the owner, below the quote's minimum 49000/);
    assert.deepEqual(calls[0], { signature: '5solSig', owner: OWNER });
    assert.equal(calls.length, 3);
  } finally { env.close(); }
  const ok = await start({ aurora: scriptedAurora([success]), solana: { credited: async () => 49_800n } });
  try {
    const { check } = await payThroughAurora(ok);
    const paid = await check();
    assert.deepEqual([paid.status, paid.paidWith, paid.transaction, paid.auroraSettled.credited, paid.aurora.status], ['PAID', 'aurora-intents', '5solSig', '49800', 'SUCCESS']);
    assert.match(paid.result, /echo test agent/);
  } finally { ok.close(); }
});

test('a quote with a deposit in flight is never replaced, an unpaid expired one is', async () => {
  const env = await start({ aurora: scriptedAurora([{ status: 'PROCESSING', deposited: '50000' }], { deadline: new Date(Date.now() - 1000).toISOString() }) });
  try {
    const { task, check } = await payThroughAurora(env);
    assert.equal((await check()).aurora.status, 'PROCESSING');
    const blocked = await env.call(`/tasks/${task.id}/aurora-quote`, { method: 'POST', body: { origin: 'base', refundTo: REFUND } });
    assert.deepEqual([blocked.status, blocked.body.error], [409, 'a deposit is still being settled (PROCESSING); wait for it to finish or be refunded']);
  } finally { env.close(); }
  const idle = await start({ aurora: scriptedAurora([{ status: 'PENDING_DEPOSIT' }], { deadline: new Date(Date.now() - 1000).toISOString() }) });
  try {
    const { task } = await payThroughAurora(idle);
    const again = await idle.call(`/tasks/${task.id}/aurora-quote`, { method: 'POST', body: { origin: 'base', refundTo: REFUND, minutes: 20 } });
    assert.deepEqual([again.status, again.body.auroraHistory.map((h) => h.status)], [200, ['EXPIRED']]);
  } finally { idle.close(); }
});

test('no owner address means no deposit address', async () => {
  const unset = await start({ aurora: scriptedAurora([{ status: 'PENDING_DEPOSIT' }]), owner: '' });
  try {
    const task = (await unset.call('/tasks', { method: 'POST', body: { description: 'One line', price: 50000 } })).body;
    assert.equal((await unset.call(`/tasks/${task.id}/aurora-quote`, { method: 'POST', body: { origin: 'base', refundTo: REFUND } })).status, 503);
    assert.equal((await unset.call('/config')).body.auroraEnabled, false);
  } finally { unset.close(); }
});

test('the demo wallet pays the 402 it is shown, once, and the page and its security headers are served', async () => {
  const seen = [];
  const demoWallet = { address: 'DemoWallet111', paymentHeaders: async (answer) => { seen.push(answer.status); return { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ x402Version: 2, accepted: answer.body.accepts[0], payload: { transaction: 'AQAB' } }) }; } };
  const env = await start({ demoWallet });
  try {
    const task = (await env.call('/tasks', { method: 'POST', body: { description: 'One line', price: 50000 } })).body;
    const paid = await env.call(`/tasks/${task.id}/demo-pay`, { method: 'POST' });
    assert.deepEqual([paid.status, paid.body.status, paid.body.paidWith, seen], [200, 'PAID', 'x402-solana-devnet', [402]]);
    assert.equal((await env.call(`/tasks/${task.id}/demo-pay`, { method: 'POST' })).body.status, 'PAID');
    assert.equal((await env.call('/config')).body.demoWallet, true);
    const page = await fetch(`${env.origin}/`);
    assert.deepEqual([page.status, page.headers.get('content-type'), /script-src 'self'/.test(page.headers.get('content-security-policy')), (await page.text()).includes('PayAgent on Solana')], [200, 'text/html; charset=utf-8', true, true]);
    assert.equal((await fetch(`${env.origin}/app.js`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${env.origin}/../package.json`)).status, 404);
  } finally { env.close(); }
  const none = await start();
  try {
    const task = (await none.call('/tasks', { method: 'POST', body: { description: 'One line', price: 50000 } })).body;
    assert.equal((await none.call(`/tasks/${task.id}/demo-pay`, { method: 'POST' })).status, 404);
  } finally { none.close(); }
});

test('behind a path prefix the page, the API and the 402 url all live under it', async () => {
  const env = await start({ basePath: '/solana' });
  try {
    assert.equal((await fetch(`${env.origin}/solana`, { redirect: 'manual' })).headers.get('location'), '/solana/');
    assert.equal((await fetch(`${env.origin}/solana/`)).status, 200);
    assert.equal((await fetch(`${env.origin}/`)).status, 404);
    const task = (await env.call('/tasks', { method: 'POST', body: { description: 'One line', price: 50000 } })).body;
    const unpaid = await env.call(`/tasks/${task.id}/result`);
    assert.equal(decodePaymentRequiredHeader(unpaid.headers.get('payment-required')).resource.url, `${env.origin}/solana/api/tasks/${task.id}/result`);
  } finally { env.close(); }
});

test('when the model fails the offline agent answers, labelled, the task is still payable, and Try again reruns the model a few times', async () => {
  let calls = 0;
  const agent = async () => { calls += 1; if (calls < 7) throw new Error('agent endpoint answered 429'); return { text: 'now it works', tokens: 3 }; };
  const env = await start({ agent });
  try {
    const task = (await env.call('/tasks', { method: 'POST', body: { description: 'One line', price: 50000 } })).body;
    assert.deepEqual([task.status, task.offline, task.canRetry, task.modelError], ['AWAITING_PAYMENT', true, true, 'agent endpoint answered 429']);
    assert.match(task.offlineNotice, /answered with its built-in offline agent/);
    assert.match(task.preview, /^Built-in offline agent: .*Your task \(2 words\): One line$/s);
    assert.equal((await env.call(`/tasks/${task.id}/result`)).status, 402); // a reviewer still reaches the payment step
    for (let i = 0; i < 3; i += 1) assert.equal((await env.call(`/tasks/${task.id}/retry`, { method: 'POST' })).body.offline, true);
    const blocked = await env.call(`/tasks/${task.id}/retry`, { method: 'POST' });
    assert.deepEqual([blocked.status, calls, (await env.call(`/tasks/${task.id}`)).body.canRetry], [409, 4, false]);
    assert.equal((await env.call('/tasks', { method: 'POST', body: { description: 'Another', price: 50000 } })).body.offline, true);
    const fresh = (await env.call('/tasks', { method: 'POST', body: { description: 'Third', price: 50000 } })).body;
    const again = (await env.call(`/tasks/${fresh.id}/retry`, { method: 'POST' })).body;
    assert.deepEqual([again.preview, again.offline, again.offlineNotice, again.canRetry], ['now it works', undefined, undefined, undefined]);
    assert.equal((await env.call(`/tasks/${fresh.id}/retry`, { method: 'POST' })).status, 409);
    const audit = (await env.call('/audit')).body.entries;
    assert.ok(audit.some((e) => e.status === 'AWAITING_PAYMENT' && e.offline === true && e.modelError === 'agent endpoint answered 429'));
  } finally { env.close(); }
});
