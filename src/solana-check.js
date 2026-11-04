// Settlement check for the Aurora flow: Aurora says SUCCESS and names the Solana transaction, but the task unlocks only if that
// transaction (finalized, read from a public RPC) really credited the owner's USDC account by the amount the quote guaranteed.
export const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';
export const FALLBACK_RPC = 'https://solana-rpc.publicnode.com';
export const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// rpcs: public RPCs rate-limit, so the next one is asked when one fails (SOLANA_RPC_URL, comma separated, replaces the defaults).
export function createSolanaCheck({ rpcs = [MAINNET_RPC, FALLBACK_RPC], fetch = globalThis.fetch } = {}) {
  async function getTransaction(rpc, signature) {
    const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction',
        params: [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }] }) });
    const { result, error } = await response.json().catch(() => ({}));
    if (error || !response.ok) throw new Error(`Solana RPC getTransaction failed: ${String(error?.message ?? response.status).slice(0, 120)}`);
    return result;
  }
  return {
    // USDC base units the transaction credited to `owner`: null while no RPC knows the transaction (not finalized yet),
    // 0n if it failed. Throws when every RPC fails; the caller treats that as "ask again later".
    async credited({ signature, owner }) {
      let result = null, answered = false, failure;
      for (const rpc of rpcs) {
        try { result = await getTransaction(rpc, signature); answered = true; } catch (error) { failure = error; continue; }
        if (result) break;
      }
      if (!result) { if (!answered) throw failure; return null; }
      if (result.meta?.err) return 0n;
      const held = (list) => new Map((list ?? []).filter((b) => b.owner === owner && b.mint === MAINNET_USDC).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
      const before = held(result.meta.preTokenBalances);
      let gained = 0n;
      for (const [index, after] of held(result.meta.postTokenBalances)) gained += after - (before.get(index) ?? 0n);
      return gained;
    }
  };
}
