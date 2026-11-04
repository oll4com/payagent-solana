// Settings from the environment. Prices are USDC base units (6 decimals) for both ways to pay: devnet USDC through x402 and
// mainnet USDC through Aurora Intents.
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function loadConfig(env = process.env) {
  const int = (name, fallback) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  const address = (name, required) => {
    const value = env[name] ?? '';
    if ((required || value) && !SOLANA_ADDRESS.test(value)) throw new Error(`${name} must be a Solana address`);
    return value;
  };
  return {
    // x402 on devnet pays this address; Aurora delivers mainnet USDC to the owner's address (optional until it is known).
    devnetReceiveAddress: address('DEVNET_RECEIVER_ADDRESS', true),
    solanaReceiveAddress: address('SOLANA_RECEIVE_ADDRESS', false),
    auroraApiKey: env.AURORA_API_KEY ?? '',
    auroraRecheckMs: int('AURORA_RECHECK_MS', 5000),
    minPrice: int('MIN_PRICE', 10_000), autoMaxPrice: int('AUTO_MAX_PRICE', 1_000_000), maxPrice: int('MAX_PRICE', 5_000_000),
    autoMaxChars: int('AUTO_MAX_CHARS', 1000),
    tasksPerIpHour: int('TASKS_PER_IP_HOUR', 5), tasksPerDay: int('TASKS_PER_DAY', 200), trustProxy: env.TRUST_PROXY === '1',
    agentMaxTokens: int('AGENT_MAX_TOKENS', 800), agentDailyTokens: int('AGENT_DAILY_TOKENS', 0),
    reviewToken: env.REVIEW_TOKEN ?? '', repoUrl: env.REPO_URL ?? '',
    // The demo's customer wallet (devnet-only key) and a path prefix when a reverse proxy serves the app under one (e.g. /solana).
    demoPayerKey: env.DEVNET_PAYER_KEY ?? '', solanaRpcUrl: env.SOLANA_RPC_URL ?? '',
    basePath: (() => { const v = env.BASE_PATH ?? ''; if (!/^(\/[a-z0-9-]+)?$/.test(v)) throw new Error('BASE_PATH must look like /solana'); return v; })(),
    port: int('PORT', 8787), dataDir: env.DATA_DIR ?? 'data'
  };
}
