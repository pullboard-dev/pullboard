/** Native session usage only: values unavailable from a provider stay null. */
import { readFileSync } from 'node:fs';

/** Accept a provider's finite nonnegative count, never a string coercion. */
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Parse a private JSONL record stream without exposing malformed content in errors. */
function records(file, bytes) {
  try {
    return (bytes ? bytes.toString('utf8') : readFileSync(file, 'utf8')).split('\n').flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return null; }
}

/** Native cumulative Codex counters, differenced before claim attribution so duplicates add nothing. */
function codex(rows) {
  const result = [];
  let previous;
  let model;
  for (const row of rows) {
    if (row.type === 'turn_context') model = row.payload?.model;
    const usage = row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info?.total_token_usage;
    if (!usage) continue;
    const input = count(usage.input_tokens);
    const output = count(usage.output_tokens);
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at)) return [];
    if (input === null || output === null) {
      result.push({ at, inputTokens: null, outputTokens: null, costUSD: null, model: typeof model === 'string' && model.trim() ? model : null });
      previous = undefined;
      continue;
    }
    // These are whole-source totals. The claim's anchored snapshot is subtracted before attribution.
    // A decreased field is independently unknown; never turn resets into positive spend.
    const deltaInput = !previous ? input : input >= previous.input ? input - previous.input : null;
    const deltaOutput = !previous ? output : output >= previous.output ? output - previous.output : null;
    previous = { input, output };
    result.push({ at, inputTokens: deltaInput, outputTokens: deltaOutput, costUSD: null, model: typeof model === 'string' && model.trim() ? model : null });
  }
  return result;
}

/** Claude transcript message usage, deduplicated by native message id across streamed updates. */
function claude(rows) {
  const messages = new Map();
  for (const row of rows) {
    const message = row.type === 'assistant' && row.message;
    if (!message || typeof message.id !== 'string' || !message.usage) continue;
    const usage = message.usage;
    const raw = count(usage.input_tokens);
    const output = count(usage.output_tokens);
    const read = usage.cache_read_input_tokens === undefined ? 0 : count(usage.cache_read_input_tokens);
    const write = usage.cache_creation_input_tokens === undefined ? 0 : count(usage.cache_creation_input_tokens);
    const at = Date.parse(row.timestamp);
    const earlier = messages.get(message.id);
    if ([raw, output, read, write].includes(null) || !Number.isFinite(at) || !Number.isSafeInteger(raw + read + write)) {
      // Keep a valid streamed version; a new unreadable usage message is unknown, never zero.
      if (!earlier && Number.isFinite(at)) messages.set(message.id, { at, inputTokens: null, outputTokens: null, costUSD: null, model: typeof message.model === 'string' && message.model.trim() ? message.model : null });
      continue;
    }
    messages.set(message.id, { at: earlier?.at ?? at, inputTokens: raw + read + write, outputTokens: output,
      costUSD: null, model: typeof message.model === 'string' && message.model.trim() ? message.model : null });
  }
  return [...messages.values()].sort((a, b) => a.at - b.at);
}

/** Read one already-identified native session; an unreadable or unsupported source is explicitly unknown. */
export function nativeUsage(source, bytes, cutoff = Infinity) {
  const parsed = source && records(source.file, bytes);
  const rows = parsed?.filter((row) => !Number.isFinite(Date.parse(row.timestamp)) || Date.parse(row.timestamp) <= cutoff);
  if (!rows) return null;
  const events = source.provider === 'codex' ? codex(rows) : source.provider === 'claude' ? claude(rows) : [];
  return events.length ? events : null;
}

/** Sanitize the documented Claude statusline cost: provider estimate, never a computed bill. */
export function claudeCostReport(payload) {
  const dollars = payload?.cost?.total_cost_usd;
  return typeof dollars === 'number' && Number.isFinite(dollars) && dollars >= 0
    ? { costUSD: dollars, estimate: true } : { costUSD: null, estimate: true };
}
