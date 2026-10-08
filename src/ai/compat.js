/**
 * COMPAT — capability probing.
 *
 * The problem this solves: a relay or gateway serves whatever the operator
 * configured under whatever names they chose. "Model exists in /models" says
 * nothing about whether it accepts `tools`, whether it streams tool calls as
 * `tool_calls` or as prose, whether it accepts `temperature`, or whether it
 * returns content at all under a thinking budget.
 *
 * Every one of those has bitten this agent before:
 *  - the model answered a probe and emitted the tool call as TEXT, so a
 *    tool-calling agent got a paragraph instead of an action;
 *  - a model returned an empty body under a large thinking budget and the
 *    probe wrote it up as "does not work", blacklisting a healthy model;
 *  - `temperature` was sent to a reasoning family that rejects it and 400s,
 *    and the router read that 400 as "key cannot use this model".
 *
 * So compat records what each model actually did, from real responses, and
 * everything downstream reads that instead of guessing.
 *
 * Nothing here is hardcoded per model id. Capability comes from observation.
 */
import { createLogger } from '../logger.js';

const log = createLogger('compat');

const PROBE_TOOL = [{
  name: 'probe_ping',
  description: 'Reply to a readiness check.',
  parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
}];

/** What we record per (provider, model). */
const EMPTY = {
  tools: null,          // true | false | null (unknown)
  streaming_tools: null,
  temperature: null,
  parallel_tools: null,
  json_object: null,
  max_tokens_field: 'max_tokens',
  probed_at: 0,
  evidence: [],
};

const cache = new Map();   // `${provider}:${model}` -> caps
const key = (p, m) => `${p}:${m}`;

export function capabilities(provider, model) {
  return { ...EMPTY, ...(cache.get(key(provider, model)) || {}) };
}

export function known() {
  return [...cache.entries()].map(([k, v]) => ({ id: k, ...v }));
}

function remember(provider, model, patch, why) {
  const k = key(provider, model);
  const next = { ...(cache.get(k) || EMPTY), ...patch, probed_at: Date.now() };
  if (why) next.evidence = [...(next.evidence || []), why].slice(-8);
  cache.set(k, next);
  return next;
}

/**
 * One real request. Never throws — a failure is a result, because "this model
 * failed" is exactly the fact compat exists to record.
 */
async function attempt(ai, { model, tools, temperature, stream, maxTokens }) {
  const args = {
    model,
    messages: [{ role: 'user', content: 'Call the probe_ping tool now. Do not reply with text.' }],
    maxTokens: maxTokens ?? 1024,
    thinking: 'off',
  };
  if (tools) args.tools = tools;
  if (temperature != null) args.temperature = temperature;
  if (stream) args.stream = true;
  return ai.chat(args);
}

function readToolCall(res) {
  return res?.toolCalls?.length ? res.toolCalls[0] : null;
}

/**
 * Probe one model and record what it can do.
 *
 * Two rounds only, because the interesting failures are binary:
 *   1. with tools  -> does it emit a structured tool call?
 *   2. no tools, temperature sent -> does it accept the classic param?
 */
export async function probeModel(ai, provider, model) {
  const out = { provider, model, ok: false };

  // ---- round 1: tool calling
  try {
    const res = await attempt(ai, { model, tools: PROBE_TOOL });
    const call = readToolCall(res);
    out.ok = true;
    out.tools = Boolean(call);
    out.evidence = out.tools
      ? `tools: ok (${call.name})`
      : `tools: NO structured tool call — it answered with text (${String(res.content || '').slice(0, 60)})`;
    remember(provider, model, {
      tools: out.tools,
      streaming_tools: false,
      max_tokens_field: 'max_tokens',
    }, out.evidence);
  } catch (e) {
    out.tools = false;
    out.error = e.message;
    remember(provider, model, { tools: false }, `tools: failed — ${e.message}`);
    log.info(`[compat] ${provider}/${model}: tool probe failed — ${e.message}`);
    return out;
  }

  // ---- round 2: temperature tolerance
  try {
    await attempt(ai, { model, temperature: 0.2 });
    out.temperature = true;
    remember(provider, model, { temperature: true }, 'temperature: accepted');
  } catch (e) {
    out.temperature = false;
    remember(provider, model, { temperature: false }, `temperature: rejected — ${e.message}`);
  }

  // ---- round 3: parallel tool calls (only meaningful if tools work at all)
  if (out.tools) {
    try {
      const res = await attempt(ai, {
        model,
        tools: [...PROBE_TOOL, { ...PROBE_TOOL[0], name: 'probe_ping2' }],
      });
      out.parallel_tools = (res?.toolCalls?.length || 0) > 1;
      remember(provider, model, { parallel_tools: out.parallel_tools },
        `parallel: ${out.parallel_tools ? 'ok' : 'serialised'}`);
    } catch (e) {
      out.parallel_tools = false;
      remember(provider, model, { parallel_tools: false }, `parallel: failed — ${e.message}`);
    }
  }

  return out;
}

/** Probe every model the router currently has selected. */
export async function probeActive(ai) {
  const results = [];
  for (const p of ai.status()) {
    if (!p.model) continue;
    results.push(await probeModel(ai, p.provider, p.model));
  }
  return results;
}

/**
 * /compat — probe an explicit list, or everything discoverable.
 *
 * `listAll` is the AI provider facade; passing it in keeps this module free of
 * any import from providers.js, so compat can never create a cycle.
 */
export async function runCompat(ai, { provider = null, models = null, onProgress = null } = {}) {
  let targets = [];
  if (models && models.length) {
    targets = models.map((m) => ({ provider: provider || 'unknown', model: m }));
  } else {
    const all = await ai.listAvailable(provider || null);
    for (const [prov, ids] of Object.entries(all)) {
      if (ids?.error) { log.warn(`[compat] ${prov}: ${ids.error}`); continue; }
      for (const id of ids) targets.push({ provider: prov, model: id });
    }
  }

  const results = [];
  for (const t of targets) {
    if (onProgress) await onProgress(t, results.length, targets.length);
    // sequential on purpose: probing fires several requests per model, and a
    // parallel burst is what turns a rate limit into a false "no models".
    results.push(await probeModel(ai, t.provider, t.model));
    await new Promise((r) => setTimeout(r, 350));
  }
  return results;
}

/**
 * Turn observations into instructions the router can act on.
 *
 * The only hard rule: a model with tools === false may not be used as the
 * agent's model, because an agent that cannot call tools cannot trade.
 */
export function routingAdvice(results) {
  const out = [];
  for (const r of results) {
    if (!r.ok) {
      out.push({ ...r, verdict: 'unusable', action: 'skip — it did not answer' });
    } else if (r.tools === false) {
      out.push({ ...r, verdict: 'chat_only', action: 'summaries/autocompact only, never the agent' });
    } else if (r.temperature === false) {
      out.push({ ...r, verdict: 'agent', action: 'agent OK — omit temperature for this one' });
    } else {
      out.push({ ...r, verdict: 'agent', action: 'agent OK' });
    }
  }
  return out;
}