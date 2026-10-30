// The worker: any OpenAI-compatible chat endpoint (AGENT_API_URL, AGENT_API_KEY, AGENT_MODEL, optional AGENT_REASONING_EFFORT).
// AGENT_MODE=echo is for local tests only and says so in its answer. Each call returns the text and the tokens the endpoint
// reports, which the service counts against its daily budget.
const SYSTEM = 'You complete one well-defined task for a paying customer. Answer with the finished work only. Keep it under '
  + '300 words unless the task needs a list or code, and never over 600 words.';

export function createAgent(env = process.env, maxTokens = 800) {
  if (env.AGENT_MODE === 'echo') return async (description) => ({ text: `[echo test agent] ${description}`, tokens: 0 });
  const { AGENT_API_URL: url, AGENT_API_KEY: key, AGENT_MODEL: model, AGENT_REASONING_EFFORT: effort } = env;
  if (!url || !key || !model) throw new Error('set AGENT_API_URL, AGENT_API_KEY and AGENT_MODEL (or AGENT_MODE=echo for tests)');
  return async (description) => {
    const response = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        // Requested only: some backends (Codex through Space Gateway, checked 27/10/2026) ignore every length parameter, so the
        // real limits are the instruction above, the reasoning effort and the service's daily token budget.
        max_tokens: maxTokens,
        ...(effort ? { reasoning_effort: effort } : {}),
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: description }]
      }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`agent endpoint answered ${response.status}`);
    const answer = await response.json();
    const text = answer.choices?.[0]?.message?.content;
    if (!text) throw new Error('agent returned no text');
    const usage = answer.usage ?? {};
    return { text, tokens: Number(usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)) || 0 };
  };
}
