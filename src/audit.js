// Append-only audit log: each line carries the hash of the one before, so any edit or deletion breaks the chain.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const GENESIS = '0'.repeat(64);

// The public log names a task only by this reference: a task id unlocks its paid result, so the id itself never appears.
export const taskRef = (taskId) => createHash('sha256').update(String(taskId)).digest('hex').slice(0, 16);
const hashOf = (prevHash, body) => createHash('sha256').update(prevHash + JSON.stringify(body)).digest('hex');

export function createAuditLog(path) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (!verifyChain(lines).ok) throw new Error(`audit log ${path} is broken; refusing to append`);
  let prevHash = lines.at(-1)?.hash ?? GENESIS;
  return {
    append(event) {
      const body = { at: new Date().toISOString(), ...event };
      const entry = { ...body, prevHash, hash: hashOf(prevHash, body) };
      appendFileSync(path, JSON.stringify(entry) + '\n');
      prevHash = entry.hash;
      return entry;
    },
    read: () => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  };
}

export function verifyChain(entries) {
  let prev = GENESIS;
  for (const [i, { prevHash, hash, ...body }] of entries.entries()) {
    if (prevHash !== prev || hash !== hashOf(prevHash, body)) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true };
}
