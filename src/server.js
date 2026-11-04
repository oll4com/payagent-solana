// HTTP API (from payagent: limits, reviewer token, security headers; payment routes new): tasks, the x402 result route on
// Solana devnet and the Aurora Intents deposit routes.
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createAuditLog, verifyChain } from './audit.js';
import { createAgent } from './agent.js';
import { createService } from './service.js';
import { createX402 } from './x402-solana.js';
import { createAurora } from './aurora.js';
import { createSolanaCheck } from './solana-check.js';
import { createDemoWallet } from './demo-wallet.js';

const MAX_BODY = 16 * 1024;
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin'
};

// The pages are a fixed list of files in public/ (no path from the request reaches the file system).
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGES = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/deck': ['deck.html', 'text/html; charset=utf-8'], '/deck.js': ['deck.js', 'text/javascript; charset=utf-8'], '/deck.css': ['deck.css', 'text/css; charset=utf-8'] };
const PUBLIC_DIR = new URL('../public/', import.meta.url);

// Fixed windows kept in memory: a restart forgets them, which only ever lets a few extra tasks through.
export function createTaskLimiter({ tasksPerIpHour, tasksPerDay }, now = () => Date.now()) {
  const perIp = new Map();
  let day = { start: 0, count: 0 };
  return (ip) => {
    const t = now();
    if (t - day.start >= 86_400_000) day = { start: t, count: 0 };
    const recent = (perIp.get(ip) ?? []).filter((at) => t - at < 3_600_000);
    if (recent.length >= tasksPerIpHour) return 'too many tasks from your address this hour; try again later';
    if (day.count >= tasksPerDay) return 'the demo has reached its task limit for today; try again tomorrow';
    recent.push(t);
    perIp.set(ip, recent);
    day.count += 1;
    return null;
  };
}

export function createApp({ config, service, audit, demoWallet = null }) {
  const limitTask = createTaskLimiter(config);
  // Behind a reverse proxy (TRUST_PROXY=1, the port reachable only by the proxy) the client is the last X-Forwarded-For entry.
  const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for']?.split(',').pop().trim()) || req.socket.remoteAddress;
  const isReviewer = (req) => {
    const given = Buffer.from(String(req.headers['x-review-token'] ?? ''));
    const want = Buffer.from(config.reviewToken);
    return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
  };
  const body = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) reject(Object.assign(new Error('body too large'), { status: 413 }));
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
  });

  return createServer(async (req, res) => {
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const requested = new URL(req.url, 'http://local').pathname;
      let pathname = requested;
      if (config.basePath) {
        if (requested === config.basePath) { res.writeHead(301, { location: `${requested}/` }); return res.end(); }
        if (!requested.startsWith(`${config.basePath}/`)) return send(404, { error: 'not found' });
        pathname = requested.slice(config.basePath.length);
      }
      const page = (req.method === 'GET' || req.method === 'HEAD') && PAGES[pathname];
      if (page) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-security-policy': PAGE_CSP, 'content-type': page[1], 'cache-control': 'no-cache' });
        return res.end(await readFile(new URL(page[0], PUBLIC_DIR)));
      }
      const [, api, resource, id, action] = pathname.split('/');
      if (api !== 'api') return send(404, { error: 'not found' });
      if (resource === 'config' && req.method === 'GET') {
        return send(200, { minPrice: config.minPrice, autoMaxPrice: config.autoMaxPrice, maxPrice: config.maxPrice,
          devnetReceiveAddress: config.devnetReceiveAddress, auroraEnabled: Boolean(config.auroraApiKey && config.solanaReceiveAddress),
          solanaReceiveAddress: config.solanaReceiveAddress || null, demoWallet: Boolean(demoWallet), repoUrl: config.repoUrl || null });
      }
      if (resource === 'audit' && req.method === 'GET') {
        const entries = audit.read();
        return send(200, { verified: verifyChain(entries), entries });
      }
      if (resource !== 'tasks') return send(404, { error: 'not found' });
      // The list hands out task ids, and an id unlocks a paid result: reviewers only.
      if (!id && req.method === 'GET') return isReviewer(req) ? send(200, service.list()) : send(403, { error: 'reviewer token required' });
      if (!id && req.method === 'POST') {
        const limited = limitTask(clientIp(req));
        if (limited) return send(429, { error: limited });
        return send(201, await service.submit(await body(req)));
      }
      if (id && !action && req.method === 'GET') return send(200, service.view(id));
      if (action === 'result' && req.method === 'GET') {
        const url = `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}${requested}`;
        const answer = await service.x402Result(id, { url, paymentSignature: req.headers['payment-signature'] });
        return send(answer.status, answer.body, answer.headers);
      }
      if (action === 'retry' && req.method === 'POST') return send(200, await service.retry(id));
      if (action === 'demo-pay' && req.method === 'POST') {
        if (!demoWallet) return send(404, { error: 'this server has no demo wallet' });
        const url = `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}${requested.replace(/demo-pay$/, 'result')}`;
        const asked = await service.x402Result(id, { url });
        if (asked.status !== 402) return send(asked.status, asked.body, asked.headers);
        const paid = await service.x402Result(id, { url, paymentSignature: (await demoWallet.paymentHeaders(asked))['PAYMENT-SIGNATURE'] });
        return send(paid.status, paid.body, paid.headers);
      }
      if (action === 'aurora-quote' && req.method === 'POST') {
        const { origin, refundTo, minutes } = await body(req);
        return send(200, await service.auroraQuote(id, { origin, refundTo, minutes }));
      }
      if (action === 'aurora-check' && req.method === 'POST') return send(200, await service.auroraCheck(id));
      if (action === 'review' && req.method === 'POST') {
        if (!isReviewer(req)) return send(403, { error: 'reviewer token required' });
        const { approve, reviewer = 'reviewer' } = await body(req);
        return send(200, await service.review(id, approve === true, String(reviewer).slice(0, 80)));
      }
      return send(404, { error: 'not found' });
    } catch (error) {
      // Input errors (bad origin, address or amount) are the caller's; anything else is logged and hidden.
      const status = error.status ?? (/must be|is not set/.test(error.message) ? 400 : 500);
      send(status, { error: status < 500 ? error.message : 'internal error' });
      if (status === 500) console.error(error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  if (!config.reviewToken || config.reviewToken.length < 24) throw new Error('set REVIEW_TOKEN to a random secret of 24+ characters');
  mkdirSync(config.dataDir, { recursive: true });
  const audit = createAuditLog(join(config.dataDir, 'audit.jsonl'));
  const service = createService({
    config, audit, agent: createAgent(process.env, config.agentMaxTokens), storePath: join(config.dataDir, 'tasks.json'),
    x402: await createX402({ payTo: config.devnetReceiveAddress }),
    aurora: config.auroraApiKey ? createAurora({ apiKey: config.auroraApiKey }) : null,
    solana: createSolanaCheck({ rpcs: config.solanaRpcUrl ? config.solanaRpcUrl.split(',').map((u) => u.trim()) : undefined })
  });
  const demoWallet = config.demoPayerKey ? await createDemoWallet(config.demoPayerKey) : null;
  createApp({ config, service, audit, demoWallet }).listen(config.port, () => console.log(`PayAgent on Solana on :${config.port}`));
}
