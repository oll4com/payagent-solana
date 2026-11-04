// Pay from another chain through Aurora Intents (Swap API, https://docs.intents.aurora.dev): a FLEX_INPUT quote turns
// USDC on the customer's chain into USDC on Solana for the owner's address, and the deposit address's status unlocks the task.
const BASE = 'https://intents-api.aurora.dev';

// NEAR Intents asset ids (GET /api/tokens): all three are USDC through the POA bridge.
export const ORIGINS = {
  arbitrum: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  base: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
};
export const SOLANA_USDC = 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';
export const FINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function createAurora({ apiKey, fetch = globalThis.fetch, base = BASE }) {
  if (!apiKey) throw new Error('AURORA_API_KEY is not set');
  // The key is a path segment: errors name the route, never the URL.
  async function call(route, init = {}, query = '') {
    const response = await fetch(`${base}/api/${route}/${encodeURIComponent(apiKey)}${query}`,
      { ...init, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Aurora ${route} answered ${response.status}: ${String(body.message ?? '').slice(0, 200)}`);
    return body;
  }
  return {
    // amount: USDC base units (6 decimals) the customer is expected to send; FLEX_INPUT swaps what arrives within the slippage band.
    // minutes: how long the quote is open; a deposit below minAmountIn by then is refunded to refundTo.
    async quote({ origin, amount, recipient, refundTo, dry = false, minutes = 120, slippageBps = 100, now = Date.now() }) {
      if (!ORIGINS[origin]) throw new Error(`origin must be one of ${Object.keys(ORIGINS).join(', ')}`);
      if (!Number.isInteger(minutes) || minutes < 10 || minutes > 240) throw new Error('minutes must be a whole number from 10 to 240');
      if (!/^[1-9]\d{0,12}$/.test(String(amount))) throw new Error('amount must be a positive integer of USDC base units');
      if (!SOLANA_ADDRESS.test(recipient)) throw new Error('recipient must be a Solana address');
      if (!EVM_ADDRESS.test(refundTo)) throw new Error('refundTo must be an EVM address on the origin chain');
      const deadline = new Date(now + minutes * 60_000).toISOString();
      const answer = await call('quote', { method: 'POST', body: JSON.stringify({
        dry, swapType: 'FLEX_INPUT', depositType: 'ORIGIN_CHAIN', slippageTolerance: slippageBps,
        originAsset: ORIGINS[origin], destinationAsset: SOLANA_USDC, amount: String(amount),
        recipient, recipientType: 'DESTINATION_CHAIN', refundTo, refundType: 'ORIGIN_CHAIN',
        deadline }) });
      const q = answer.quote ?? {};
      if (!dry && !q.depositAddress) throw new Error('Aurora quote has no deposit address');
      // Aurora answers deadline = the one asked + 72 h (the deposit address stays active that long), so `deadline` is the asked one.
      return { origin, depositAddress: q.depositAddress ?? null, depositMemo: q.depositMemo ?? null,
        amountIn: q.amountIn, minAmountIn: q.minAmountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut,
        refundFee: q.refundFee ?? null, timeEstimate: q.timeEstimate, deadline, activeUntil: q.timeWhenInactive ?? q.deadline ?? null,
        correlationId: answer.correlationId };
    },
    async status(depositAddress, depositMemo) {
      const query = `?depositAddress=${encodeURIComponent(depositAddress)}${depositMemo ? `&depositMemo=${encodeURIComponent(depositMemo)}` : ''}`;
      const answer = await call('status', {}, query);
      const details = answer.swapDetails ?? {};
      return { status: answer.status, final: FINAL.has(answer.status), deposited: details.depositedAmount ?? null,
        amountOut: details.amountOut ?? null, destinationTx: details.destinationChainTxHashes?.[0]?.hash ?? null,
        refunded: details.refundedAmount ?? null, refundReason: details.refundReason ?? null,
        originTxs: (details.originChainTxHashes ?? []).map(({ hash, explorerUrl }) => ({ hash, explorerUrl })) };
    }
  };
}
