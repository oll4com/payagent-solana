import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSolanaCheck, MAINNET_USDC } from '../src/solana-check.js';

const OWNER = 'HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16';
const balance = (accountIndex, owner, amount, mint = MAINNET_USDC) => ({ accountIndex, owner, mint, uiTokenAmount: { amount: String(amount) } });
const rpcAnswer = (body, ok = true) => async () => ({ ok, json: async () => body });
const check = (body, ok) => createSolanaCheck({ rpcs: ['https://rpc.test'], fetch: rpcAnswer(body, ok) });

test('the credit is the owner\'s USDC balance change, whatever other balances moved', async () => {
  const result = { meta: { err: null,
    preTokenBalances: [balance(1, OWNER, 5_000_000), balance(2, 'Other', 9_000_000)],
    postTokenBalances: [balance(1, OWNER, 7_950_000), balance(2, 'Other', 6_050_000), balance(3, OWNER, 1, 'SomeOtherMint')] } };
  assert.equal(await check({ result }).credited({ signature: 's', owner: OWNER }), 2_950_000n);
});

test('a new token account counts from zero, and a transaction that credited nothing to the owner is 0', async () => {
  const fresh = { meta: { err: null, preTokenBalances: [], postTokenBalances: [balance(4, OWNER, 2_959_542)] } };
  assert.equal(await check({ result: fresh }).credited({ signature: 's', owner: OWNER }), 2_959_542n);
  assert.equal(await check({ result: fresh }).credited({ signature: 's', owner: 'Somebody' }), 0n);
});

test('a failed transaction credits nothing, an unknown one is null, an RPC failure throws', async () => {
  assert.equal(await check({ result: { meta: { err: { InstructionError: [0, 'Custom'] } } } }).credited({ signature: 's', owner: OWNER }), 0n);
  assert.equal(await check({ result: null }).credited({ signature: 's', owner: OWNER }), null);
  await assert.rejects(check({ error: { message: 'Too many requests for a specific RPC call' } }).credited({ signature: 's', owner: OWNER }), /Too many requests/);
  await assert.rejects(check({}, false).credited({ signature: 's', owner: OWNER }), /getTransaction failed/);
});

test('it asks for the finalized transaction in parsed form', async () => {
  let sent;
  const fetch = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ result: null }) }; };
  await createSolanaCheck({ rpcs: ['https://rpc.test'], fetch }).credited({ signature: 'sig1', owner: OWNER });
  assert.deepEqual([sent.method, sent.params[0], sent.params[1].commitment, sent.params[1].encoding], ['getTransaction', 'sig1', 'finalized', 'jsonParsed']);
});

test('when one RPC is rate-limited or has not seen the transaction yet the next is asked; all failing throws, none knowing it is null', async () => {
  const fresh = { meta: { err: null, preTokenBalances: [], postTokenBalances: [balance(4, OWNER, 2_959_542)] } };
  const byUrl = (answers) => async (url) => answers[url]();
  const ok = (body) => () => ({ ok: true, json: async () => body });
  const limited = () => ({ ok: false, json: async () => ({ error: { message: 'Too many requests' } }) });
  const rpcs = ['https://a.test', 'https://b.test'];
  assert.equal(await createSolanaCheck({ rpcs, fetch: byUrl({ 'https://a.test': limited, 'https://b.test': ok({ result: fresh }) }) }).credited({ signature: 's', owner: OWNER }), 2_959_542n);
  assert.equal(await createSolanaCheck({ rpcs, fetch: byUrl({ 'https://a.test': ok({ result: null }), 'https://b.test': ok({ result: fresh }) }) }).credited({ signature: 's', owner: OWNER }), 2_959_542n);
  assert.equal(await createSolanaCheck({ rpcs, fetch: byUrl({ 'https://a.test': limited, 'https://b.test': ok({ result: null }) }) }).credited({ signature: 's', owner: OWNER }), null);
  await assert.rejects(createSolanaCheck({ rpcs, fetch: byUrl({ 'https://a.test': limited, 'https://b.test': limited }) }).credited({ signature: 's', owner: OWNER }), /Too many requests/);
});
