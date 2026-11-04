// The task flow (from payagent, the payment step replaced): submit -> policy gate -> (person accepts) -> agent works ->
// the customer sees a preview and pays, with x402 on Solana devnet or from another chain through Aurora Intents ->
// the full result is released. Every step goes to the audit log.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { decide } from './policy.js';
import { taskRef } from './audit.js';
import { OFFLINE_NOTICE, offlineAnswer } from './agent.js';

const PREVIEW_CHARS = 280;
const MAX_RETRIES = 3; // model calls cost money on a public demo: a failed task may be run again this many times
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createService({ config, audit, agent, storePath, x402, aurora, solana }) {
  const lastAuroraRead = new Map();
  const tasks = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : {};
  const save = () => writeFileSync(storePath, JSON.stringify(tasks, null, 2));
  const get = (id) => tasks[id] ?? (() => { throw fail(404, 'task not found'); })();
  const move = (task, status, { auditDetail, ...fields } = {}) => {
    Object.assign(task, fields, { status, updatedAt: new Date().toISOString() });
    save();
    audit.append({ task: taskRef(task.id), status, ...auditDetail });
  };
  const awaiting = (task) => { if (task.status !== 'AWAITING_PAYMENT') throw fail(409, `task is ${task.status}`); };

  // Tokens the model reported for tasks worked today (UTC), from the stored tasks, so a restart forgets nothing.
  const tokensToday = () => {
    const today = new Date().toISOString().slice(0, 10);
    return Object.values(tasks).reduce((sum, t) => sum + (t.workedAt?.startsWith(today) ? t.agentTokens ?? 0 : 0), 0);
  };
  const assertBudget = () => {
    if (config.agentDailyTokens > 0 && tokensToday() >= config.agentDailyTokens) {
      throw fail(503, "the demo's model budget for today is used up; try again after 00:00 UTC");
    }
  };

  // The model is the demo's weakest part (shared rate limits): when it fails, the built-in offline agent answers, labelled as such,
  // so a reviewer still reaches the payment step; "Try again" runs the real model again (a few times).
  async function run(task) {
    move(task, 'WORKING');
    let text, tokens = 0, modelError;
    try { ({ text, tokens = 0 } = await agent(task.description)); } catch (error) { modelError = error.message; text = offlineAnswer(task.description); }
    delete task.offline;
    delete task.modelError;
    const offline = modelError === undefined ? {} : { offline: true, modelError };
    move(task, 'AWAITING_PAYMENT', { ...offline, result: String(text), workedAt: new Date().toISOString(), agentTokens: tokens,
      auditDetail: { resultChars: String(text).length, tokens, price: task.price, ...offline } });
  }

  const amount = (v) => (/^\d+$/.test(String(v ?? '')) ? BigInt(v) : 0n);
  async function settleAurora(task, s) {
    const a = task.aurora;
    const reject = (problem) => {
      Object.assign(a, { status: 'SUCCESS', problem });
      save();
      audit.append({ task: taskRef(task.id), status: 'AURORA_SETTLEMENT_REJECTED', problem, deposited: s.deposited, amountOut: s.amountOut, transaction: s.destinationTx });
    };
    // Not provable yet: Aurora has not named the Solana transaction, or Solana does not know it as finalized. Ask again next time.
    if (!s.destinationTx) return;
    if (amount(s.deposited) < amount(a.minAmountIn)) return reject(`Aurora reports ${s.deposited} deposited, below the quote's minimum ${a.minAmountIn}`);
    if (amount(s.amountOut) < amount(a.minAmountOut)) return reject(`Aurora reports ${s.amountOut} delivered, below the quote's minimum ${a.minAmountOut}`);
    let onChain = null;
    if (solana) {
      try { onChain = await solana.credited({ signature: s.destinationTx, owner: config.solanaReceiveAddress }); } catch { return; }
      if (onChain === null) return;
      if (onChain < amount(a.minAmountOut)) return reject(`Solana shows ${onChain} credited to the owner, below the quote's minimum ${a.minAmountOut}`);
    }
    a.status = 'SUCCESS';
    move(task, 'PAID', { paidWith: 'aurora-intents', transaction: s.destinationTx, auroraSettled: { deposited: s.deposited, amountOut: s.amountOut, credited: onChain?.toString() ?? null },
      auditDetail: { paidWith: 'aurora-intents', origin: a.origin, deposited: s.deposited, amountOut: s.amountOut, credited: onChain?.toString(), transaction: s.destinationTx } });
  }

  return {
    async submit({ description, price }) {
      description = String(description ?? '').trim();
      price = Number(price);
      if (!description || description.length > 4000) throw fail(400, 'description must be 1-4000 characters');
      if (!Number.isSafeInteger(price) || price <= 0) throw fail(400, 'price must be a positive integer of USDC base units');
      const { decision, ruleId } = decide({ description, price }, config);
      if (decision === 'AUTO') assertBudget();
      const task = { id: randomUUID(), description, price, createdAt: new Date().toISOString() };
      tasks[task.id] = task;
      const status = { AUTO: 'ACCEPTED', APPROVE: 'NEEDS_APPROVAL', REFUSE: 'REFUSED' }[decision];
      move(task, status, { ruleId, auditDetail: { decision, ruleId, price } });
      if (status === 'ACCEPTED') await run(task);
      return this.view(task.id);
    },

    // The task was answered offline because the model failed: run it through the model again.
    async retry(id) {
      const task = get(id);
      if (task.status !== 'AWAITING_PAYMENT' || !task.offline) throw fail(409, 'only a task answered by the offline agent can be run again');
      // shortcut: a quote that lapsed unpaid still blocks this, upgrade by letting a lapsed quote go first.
      if (task.aurora) throw fail(409, 'a cross-chain quote is open on this task; the result must not change under it');
      if ((task.retries ?? 0) >= MAX_RETRIES) throw fail(409, `the model failed ${MAX_RETRIES + 1} times on this task; submit it again later`);
      assertBudget();
      task.retries = (task.retries ?? 0) + 1;
      move(task, 'ACCEPTED', { auditDetail: { retry: task.retries } });
      await run(task);
      return this.view(id);
    },

    // A person accepts or declines a task the policy held.
    async review(id, approve, reviewer) {
      const task = get(id);
      if (task.status !== 'NEEDS_APPROVAL') throw fail(409, `task is ${task.status}`);
      if (approve) assertBudget();
      move(task, approve ? 'ACCEPTED' : 'DECLINED', { auditDetail: { reviewer } });
      if (approve) await run(task);
      return this.view(id);
    },

    // x402: without a PAYMENT-SIGNATURE the result answers 402; with one it is released only once the payment is settled.
    async x402Result(id, { url, paymentSignature }) {
      const task = get(id);
      if (task.status === 'PAID') return { status: 200, body: this.view(id) };
      awaiting(task);
      const required = (error) => x402.paymentRequired({ amount: task.price, url, description: `Result of task ${taskRef(id)}` }, error);
      if (!paymentSignature) return required();
      const paid = await x402.pay({ amount: task.price, headerValue: paymentSignature });
      if (!paid.ok) {
        audit.append({ task: taskRef(id), status: 'PAYMENT_REFUSED', reason: paid.reason });
        return required(paid.reason);
      }
      move(task, 'PAID', { paidWith: 'x402-solana-devnet', transaction: paid.transaction, payer: paid.payer,
        auditDetail: { paidWith: 'x402-solana-devnet', transaction: paid.transaction, network: paid.network } });
      return { status: 200, headers: paid.headers, body: this.view(id) };
    },

    // Aurora: a FLEX_INPUT deposit address on the customer's chain that delivers USDC on Solana to the owner. The quote is what the
    // customer paid for: a deposit of at least minAmountIn that delivers at least minAmountOut unlocks the task; less is refunded.
    async auroraQuote(id, { origin, refundTo, minutes }) {
      const task = get(id);
      awaiting(task);
      if (!aurora || !config.solanaReceiveAddress) throw fail(503, 'paying from another chain is not set up on this server');
      const open = task.aurora;
      if (open && Date.parse(open.deadline) > Date.now()) return this.view(id);
      // A deposit Aurora already saw is settled or refunded first; only a quote nobody paid into may be replaced.
      // shortcut: a deposit that lands on a replaced quote's address is still swapped for the owner but no longer unlocks the task, upgrade by watching every open address.
      if (open && open.status !== 'PENDING_DEPOSIT') throw fail(409, `a deposit is still being settled (${open.status}); wait for it to finish or be refunded`);
      if (open) (task.auroraHistory ??= []).push({ ...open, endedAt: new Date().toISOString(), status: 'EXPIRED' });
      const q = await aurora.quote({ origin, amount: task.price, recipient: config.solanaReceiveAddress, refundTo, minutes });
      task.aurora = { origin, refundTo, depositAddress: q.depositAddress, depositMemo: q.depositMemo, amountIn: q.amountIn,
        minAmountIn: q.minAmountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut, refundFee: q.refundFee,
        deadline: q.deadline, activeUntil: q.activeUntil, status: 'PENDING_DEPOSIT' };
      save();
      audit.append({ task: taskRef(id), status: 'AURORA_QUOTE', origin, depositAddress: q.depositAddress, amountIn: q.amountIn, minAmountIn: q.minAmountIn, deadline: q.deadline });
      return this.view(id);
    },

    // Reads the swap's status at most once per interval, however often clients ask. SUCCESS releases the result only after the
    // amounts match the quote and the delivery shows on Solana; a refunded or failed swap is kept in the task's history.
    async auroraCheck(id) {
      const task = get(id);
      const a = task.aurora;
      if (!a || task.status !== 'AWAITING_PAYMENT' || a.problem) return this.view(id);
      const now = Date.now();
      if (now - (lastAuroraRead.get(id) ?? 0) < config.auroraRecheckMs) return this.view(id);
      lastAuroraRead.set(id, now);
      const s = await aurora.status(a.depositAddress, a.depositMemo);
      if (s.status === 'SUCCESS') { await settleAurora(task, s); return this.view(id); }
      if (s.status !== a.status) {
        Object.assign(a, { status: s.status, deposited: s.deposited });
        if (s.final) {
          (task.auroraHistory ??= []).push({ ...a, refunded: s.refunded, refundReason: s.refundReason, originTxs: s.originTxs, endedAt: new Date().toISOString() });
          delete task.aurora;
        }
        save();
        audit.append({ task: taskRef(id), status: `AURORA_${s.status}`, deposited: s.deposited ?? undefined,
          refunded: s.final ? s.refunded ?? undefined : undefined, refundReason: s.refundReason ?? undefined });
      }
      return this.view(id);
    },

    view(id) {
      const { result, ...task } = get(id);
      return { ...task, ref: taskRef(task.id), preview: result?.slice(0, PREVIEW_CHARS), result: task.status === 'PAID' ? result : undefined,
        ...(task.offline ? { offlineNotice: OFFLINE_NOTICE, canRetry: task.status === 'AWAITING_PAYMENT' && !task.aurora && (task.retries ?? 0) < MAX_RETRIES } : {}) };
    },
    list: () => Object.keys(tasks).map((id) => ({ id, status: tasks[id].status, price: tasks[id].price, createdAt: tasks[id].createdAt }))
  };
}
