// The demo page: a task, its policy verdict, then payment with x402 (Solana devnet) or from another chain (Aurora Intents).
// Server text goes in with textContent only (the page's CSP forbids inline script and style).
const $ = (id) => document.getElementById(id);
const api = async (path, init = {}) => {
  const response = await fetch(`api/${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, headers: response.headers, body };
};
const usdc = (units) => (units == null ? '?' : String(Number(units) / 1e6));
const CHAINS = { arbitrum: 'Arbitrum One', base: 'Base', ethereum: 'Ethereum', optimism: 'Optimism', polygon: 'Polygon', avalanche: 'Avalanche C-Chain' };
const STATUS = {
  ACCEPTED: 'Accepted by the policy; the agent is starting.', WORKING: 'The agent is working…',
  NEEDS_APPROVAL: 'Held by the policy for a reviewer (tasks above 1 USDC or 1,000 characters wait for a person).',
  REFUSED: 'Refused by the policy.', DECLINED: 'Declined by the reviewer.', FAILED: 'The agent failed on this task.',
  AWAITING_PAYMENT: 'Done. Pay to unlock the full result.', PAID: 'Paid. The result is unlocked.'
};
const AURORA = {
  PENDING_DEPOSIT: 'Waiting for your deposit.', KNOWN_DEPOSIT_TX: 'Deposit seen; waiting for the chain to confirm it.',
  INCOMPLETE_DEPOSIT: 'Deposit below the minimum; send the difference before the deadline or it is refunded.',
  PROCESSING: 'Deposit received; Aurora is swapping and paying out on Solana.', SUCCESS: 'Swapped and delivered on Solana.',
  REFUNDED: 'Refunded to your address.', FAILED: 'The swap failed.', EXPIRED: 'Quote closed without a deposit.'
};
let config = {}, taskId = location.hash.startsWith('#task=') ? location.hash.slice(6) : null, timer = null, current = null;

function link(text, href) {
  const a = document.createElement('a');
  a.textContent = text;
  if (/^https:\/\//.test(href)) { a.href = href; a.rel = 'noopener'; }
  return a;
}
function facts(list, rows) {
  list.replaceChildren(...rows.filter(Boolean).flatMap(([name, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = name;
    dd.append(value);
    return [dt, dd];
  }));
}
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '?');
const code = (text) => Object.assign(document.createElement('code'), { textContent: text });

function showError(id, message) { $(id).textContent = message ?? ''; $(id).hidden = !message; }

function render(task) {
  current = task;
  location.hash = `task=${task.id}`;
  $('task-section').hidden = false;
  facts($('facts'), [['Policy', `${task.status === 'REFUSED' ? 'refuse' : 'decision'}: ${task.ruleId ?? '?'}`], ['Price', `${usdc(task.price)} USDC`], ['Reference', code(task.ref)]]);
  $('status-line').textContent = task.status === 'FAILED' ? `The agent failed on this task (${task.error ?? 'unknown error'}). The model may be busy; try again in a minute.` : STATUS[task.status] ?? task.status;
  $('retry').hidden = task.status !== 'FAILED';
  $('preview').textContent = task.preview ?? (task.status === 'REFUSED' ? 'No work was done.' : '');
  const payable = task.status === 'AWAITING_PAYMENT';
  $('pay').hidden = !payable;
  $('result-box').hidden = task.status !== 'PAID';
  if (task.status === 'PAID') renderPaid(task);
  if (payable) renderAurora(task);
  clearInterval(timer);
  timer = null;
  if (task.aurora && payable) timer = setInterval(checkAurora, 5000);
  if (['ACCEPTED', 'WORKING'].includes(task.status)) timer = setInterval(reload, 2000);
  loadAudit();
}

function renderPaid(task) {
  $('result-text').textContent = task.result ?? '';
  const settled = $('settlement');
  settled.replaceChildren();
  if (task.paidWith === 'aurora-intents') {
    const s = task.auroraSettled ?? {};
    settled.append(`Paid from ${CHAINS[task.aurora?.origin] ?? 'another chain'} through Aurora Intents. Deposited ${usdc(s.deposited)} USDC; ${usdc(s.credited ?? s.amountOut)} USDC reached the owner on Solana mainnet: `,
      link('transaction', `https://solscan.io/tx/${task.transaction}`), '.');
  } else {
    settled.append('Paid with x402 on Solana devnet: ', link('transaction', `https://explorer.solana.com/tx/${task.transaction}?cluster=devnet`), '.');
  }
}

function renderAurora(task) {
  const a = task.aurora;
  // A quote nobody paid into and whose time is up may be replaced; the server refuses a new one while a deposit is in flight.
  const lapsed = Boolean(a) && a.status === 'PENDING_DEPOSIT' && Date.parse(a.deadline) < Date.now();
  $('aurora-form').hidden = !config.auroraEnabled || (Boolean(a) && !lapsed);
  $('aurora-off').hidden = Boolean(config.auroraEnabled);
  $('aurora-box').hidden = !a;
  if (a) {
    const address = document.createElement('span');
    address.append(code(a.depositAddress), ' ');
    const copy = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Copy' });
    copy.addEventListener('click', () => navigator.clipboard?.writeText(a.depositAddress).then(() => { copy.textContent = 'Copied'; }));
    address.append(copy);
    facts($('aurora-facts'), [
      [`Send USDC on ${CHAINS[a.origin]} to`, address],
      ['Amount', `${usdc(a.amountIn)} USDC (at least ${usdc(a.minAmountIn)})`],
      ['The owner receives', `at least ${usdc(a.minAmountOut)} USDC on Solana`],
      ['Send before', when(a.deadline)],
      ['Refunds go to', code(a.refundTo)],
      a.refundFee ? ['Refund fee', `${usdc(a.refundFee)} USDC`] : null
    ]);
    $('aurora-status').textContent = a.problem ? `Aurora reported a result that does not match the quote (${a.problem}). The owner will check it.`
      : a.status === 'INCOMPLETE_DEPOSIT' ? `Aurora received ${usdc(a.deposited)} USDC, below the minimum ${usdc(a.minAmountIn)}. Send the difference before ${when(a.deadline)} or it is refunded to the address above.`
      : `Status: ${a.status}. ${AURORA[a.status] ?? ''}`;
  }
  $('aurora-history').replaceChildren(...(task.auroraHistory ?? []).map((h) => {
    const li = document.createElement('li');
    li.append(`Quote on ${CHAINS[h.origin]}: ${h.status}. ${AURORA[h.status] ?? ''}`);
    if (h.status === 'REFUNDED') {
      li.append(` ${usdc(h.refunded)} USDC went back to `, code(h.refundTo), h.refundReason ? ` (reason: ${h.refundReason})` : '', '. ');
      for (const [i, tx] of (h.originTxs ?? []).entries()) li.append(link(`transaction ${i + 1}`, tx.explorerUrl), ' ');
    }
    return li;
  }));
}

async function reload() { if (taskId) render((await api(`tasks/${taskId}`)).body); }
async function checkAurora() {
  const { status, body } = await api(`tasks/${taskId}/aurora-check`, { method: 'POST' });
  if (status === 200) render(body);
}

async function loadAudit() {
  const { body } = await api('audit');
  $('audit-verdict').textContent = body.verified?.ok ? `Chain verified: ${body.entries.length} entries, each linked to the one before.` : 'The audit chain does not verify.';
  $('audit-list').replaceChildren(...(body.entries ?? []).map((e) => {
    const li = document.createElement('li');
    const { at, status, hash, prevHash, ...rest } = e;
    li.append(`${when(at)} ${status} `, code(JSON.stringify(rest)));
    return li;
  }));
}

$('new-task').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('new-error');
  const { status, body } = await api('tasks', { method: 'POST', body: JSON.stringify({ description: $('description').value, price: Math.round(Number($('price').value) * 1e6) }) });
  if (status !== 201) return showError('new-error', body.error ?? `Error ${status}`);
  taskId = body.id;
  render(body);
});
$('show-402').addEventListener('click', async () => {
  const { status, body } = await api(`tasks/${taskId}/result`);
  $('x402-out').hidden = false;
  $('x402-out').textContent = `HTTP ${status}\n${JSON.stringify(body, null, 2)}`;
});
$('demo-pay').addEventListener('click', async () => {
  $('demo-pay').disabled = true;
  const { status, body } = await api(`tasks/${taskId}/demo-pay`, { method: 'POST' });
  $('demo-pay').disabled = false;
  if (status === 200) return render(body);
  $('x402-out').hidden = false;
  $('x402-out').textContent = `HTTP ${status}\n${body.error ?? JSON.stringify(body, null, 2)}`;
});
$('aurora-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('aurora-error');
  const { status, body } = await api(`tasks/${taskId}/aurora-quote`, { method: 'POST', body: JSON.stringify({ origin: $('origin').value, refundTo: $('refund-to').value.trim(), minutes: Number($('minutes').value) }) });
  if (status !== 200) return showError('aurora-error', body.error ?? `Error ${status}`);
  render(body);
});
$('retry').addEventListener('click', async () => {
  $('retry').disabled = true;
  const { status, body } = await api(`tasks/${taskId}/retry`, { method: 'POST' });
  $('retry').disabled = false;
  if (status === 200) render(body);
  else $('status-line').textContent = body.error ?? `Error ${status}`;
});
$('audit-refresh').addEventListener('click', loadAudit);

config = (await api('config')).body;
if (config.repoUrl) $('repo-link').href = config.repoUrl;
$('demo-pay').hidden = !config.demoWallet;
$('price').min = String(config.minPrice / 1e6);
$('price').max = String(config.maxPrice / 1e6);
if (taskId) await reload();
else loadAudit();
