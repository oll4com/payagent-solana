// The gate in front of the agent: every task gets AUTO (run now), APPROVE (a person must accept it first) or REFUSE,
// with the id of the rule that decided, so the audit log says why.
const BLOCKED = ['private key', 'seed phrase', 'mnemonic', 'password', 'malware', 'phishing'];

export const defaultRules = [
  { id: 'refuse-secrets-or-abuse', decision: 'REFUSE', when: (t) => BLOCKED.some((w) => t.description.toLowerCase().includes(w)) },
  { id: 'refuse-above-max-price', decision: 'REFUSE', when: (t, c) => t.priceSats > c.maxPriceSats },
  { id: 'refuse-below-min-price', decision: 'REFUSE', when: (t, c) => t.priceSats < c.minPriceSats },
  { id: 'approve-above-auto-limit', decision: 'APPROVE', when: (t, c) => t.priceSats > c.autoMaxSats },
  { id: 'approve-long-task', decision: 'APPROVE', when: (t, c) => t.description.length > c.autoMaxChars },
  { id: 'auto-small-task', decision: 'AUTO', when: () => true }
];

export function decide(task, config, rules = defaultRules) {
  const rule = rules.find((r) => r.when(task, config));
  return { decision: rule.decision, ruleId: rule.id };
}
