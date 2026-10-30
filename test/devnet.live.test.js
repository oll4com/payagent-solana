// LIVE=1 node --env-file=.env --test test/devnet.live.test.js: a real x402 payment on Solana devnet (devnet USDC from the
// payer to the receiver, settled by PayAI). Skipped by default: it spends faucet USDC and needs the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createX402 } from '../src/x402-solana.js';
import { payUrl } from '../scripts/devnet-pay.mjs';

test('a 402 result is paid on devnet and unlocks once settled', { skip: process.env.LIVE !== '1', timeout: 120_000 }, async () => {
  const x402 = await createX402({ payTo: process.env.DEVNET_RECEIVER_ADDRESS });
  const amount = 10_000; // 0.01 devnet USDC
  const server = createServer(async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    const header = req.headers['payment-signature'];
    const send = (status, headers, body) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (!header) { const r = await x402.paymentRequired({ amount, url, description: 'live devnet check' }); return send(r.status, r.headers, r.body); }
    const paid = await x402.pay({ amount, headerValue: header });
    if (!paid.ok) { const r = await x402.paymentRequired({ amount, url, description: 'live devnet check' }, paid.reason); return send(r.status, r.headers, r.body); }
    send(200, paid.headers, { result: 'unlocked', transaction: paid.transaction });
  }).listen(0);
  try {
    const result = await payUrl(`http://127.0.0.1:${server.address().port}/result`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.result, 'unlocked');
    assert.match(result.settlement.transaction, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    console.log(`devnet transaction: https://explorer.solana.com/tx/${result.settlement.transaction}?cluster=devnet`);
  } finally { server.close(); }
});
