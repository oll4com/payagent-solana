// The task flow (from payagent, the payment step replaced): submit -> policy gate -> (person accepts) -> agent works ->
// the customer sees a preview and pays, with x402 on Solana devnet or from another chain through Aurora Intents ->
// the full result is released. Every step goes to the audit log.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { decide } from './policy.js';
import { taskRef } from './audit.js';

const PREVIEW_CHARS = 280;
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createService({ config, audit, agent, storePath, x402, aurora }) {
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

  async function run(task) {
    move(task, 'WORKING');
    try {
      const { text, tokens = 0 } = await agent(task.description);
      const now = new Date().toISOString();
      move(task, 'AWAITING_PAYMENT', { result: String(text), workedAt: now, agentTokens: tokens,
        auditDetail: { resultChars: String(text).length, tokens, price: task.price } });
    } catch (error) {
      move(task, 'FAILED', { error: error.message, auditDetail: { error: error.message } });
    }
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

    // Aurora: a FLEX_INPUT deposit address on the customer's chain that delivers USDC on Solana to the owner.
    async auroraQuote(id, { origin, refundTo }) {
      const task = get(id);
      awaiting(task);
      if (!aurora || !config.solanaReceiveAddress) throw fail(503, 'paying from another chain is not set up on this server');
      if (task.aurora && Date.parse(task.aurora.deadline) > Date.now()) return this.view(id);
      const q = await aurora.quote({ origin, amount: task.price, recipient: config.solanaReceiveAddress, refundTo });
      task.aurora = { origin, depositAddress: q.depositAddress, depositMemo: q.depositMemo, amountIn: q.amountIn,
        minAmountIn: q.minAmountIn, minAmountOut: q.minAmountOut, deadline: q.deadline, status: 'PENDING_DEPOSIT' };
      save();
      audit.append({ task: taskRef(id), status: 'AURORA_QUOTE', origin, depositAddress: q.depositAddress, amountIn: q.amountIn });
      return this.view(id);
    },

    // Reads the swap's status at most once per interval, however often clients ask; SUCCESS releases the result.
    async auroraCheck(id) {
      const task = get(id);
      if (!task.aurora || task.status !== 'AWAITING_PAYMENT') return this.view(id);
      const now = Date.now();
      if (now - (lastAuroraRead.get(id) ?? 0) < config.auroraRecheckMs) return this.view(id);
      lastAuroraRead.set(id, now);
      const s = await aurora.status(task.aurora.depositAddress, task.aurora.depositMemo);
      if (s.status === task.aurora.status) return this.view(id);
      task.aurora.status = s.status;
      if (s.status === 'SUCCESS') {
        move(task, 'PAID', { paidWith: 'aurora-intents', transaction: s.destinationTx,
          auditDetail: { paidWith: 'aurora-intents', origin: task.aurora.origin, deposited: s.deposited, amountOut: s.amountOut, transaction: s.destinationTx } });
      } else {
        // A refunded or failed swap leaves the task payable: the customer may ask for a new deposit address.
        if (s.final) delete task.aurora;
        save();
        audit.append({ task: taskRef(id), status: `AURORA_${s.status}`, refunded: s.refunded ?? undefined });
      }
      return this.view(id);
    },

    view(id) {
      const { result, ...task } = get(id);
      return { ...task, ref: taskRef(task.id), preview: result?.slice(0, PREVIEW_CHARS), result: task.status === 'PAID' ? result : undefined };
    },
    list: () => Object.keys(tasks).map((id) => ({ id, status: tasks[id].status, price: tasks[id].price, createdAt: tasks[id].createdAt }))
  };
}
