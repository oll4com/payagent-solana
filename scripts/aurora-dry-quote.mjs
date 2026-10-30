// node --env-file=.env scripts/aurora-dry-quote.mjs [arbitrum|base] [usdc] <solana-recipient> <evm-refund-address>
// Prices a payment from another chain without reserving a deposit address (Aurora has no testnet; dry costs nothing).
import { createAurora } from '../src/aurora.js';
const [origin = 'arbitrum', usdc = '2.8', recipient, refundTo] = process.argv.slice(2);
if (!recipient || !refundTo) { console.error('usage: aurora-dry-quote.mjs <origin> <usdc> <solana-recipient> <evm-refund-address>'); process.exit(2); }
const q = await createAurora({ apiKey: process.env.AURORA_API_KEY })
  .quote({ origin, amount: Math.round(Number(usdc) * 1e6), recipient, refundTo, dry: true });
console.log(`${origin}: send ${q.amountIn / 1e6} USDC (at least ${q.minAmountIn / 1e6}) -> ${q.amountOut / 1e6} USDC on Solana (at least ${q.minAmountOut / 1e6}), ~${q.timeEstimate} s`);
