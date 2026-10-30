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

async function start({ aurora = null, owner = OWNER } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'payagent-solana-'));
  const config = loadConfig({ DEVNET_RECEIVER_ADDRESS: DEVNET_RECEIVER, SOLANA_RECEIVE_ADDRESS: owner, AURORA_API_KEY: aurora ? 'k' : '',
    AURORA_RECHECK_MS: '0', REVIEW_TOKEN: 'r'.repeat(24), DATA_DIR: dir });
  const audit = createAuditLog(join(dir, 'audit.jsonl'));
  const service = createService({ config, audit, agent: createAgent({ AGENT_MODE: 'echo' }), storePath: join(dir, 'tasks.json'),
    x402: await createX402({ payTo: DEVNET_RECEIVER, facilitator }), aurora });
  const server = createApp({ config, service, audit }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  return { call, close: () => server.close() };
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

test('a refunded swap leaves the task payable, and no owner address means no deposit address', async () => {
  const aurora = {
    quote: async () => ({ depositAddress: '0xDeposit', amountIn: '50000', deadline: new Date(Date.now() + 3600e3).toISOString() }),
    status: async () => ({ status: 'REFUNDED', final: true, refunded: '50000' })
  };
  const { call, close } = await start({ aurora });
  try {
    const task = (await call('/tasks', { method: 'POST', body: { description: 'One line', price: 50000 } })).body;
    await call(`/tasks/${task.id}/aurora-quote`, { method: 'POST', body: { origin: 'base', refundTo: REFUND } });
    const after = (await call(`/tasks/${task.id}/aurora-check`, { method: 'POST' })).body;
    assert.deepEqual([after.status, after.aurora], ['AWAITING_PAYMENT', undefined]);
  } finally { close(); }
  const unset = await start({ aurora, owner: '' });
  try {
    const task = (await unset.call('/tasks', { method: 'POST', body: { description: 'One line', price: 50000 } })).body;
    assert.equal((await unset.call(`/tasks/${task.id}/aurora-quote`, { method: 'POST', body: { origin: 'base', refundTo: REFUND } })).status, 503);
  } finally { unset.close(); }
});
