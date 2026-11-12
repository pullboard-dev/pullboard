/** Native session usage only: values unavailable from a provider stay null. */
import { readFileSync } from 'node:fs';
import { unknownInputSplit } from './usage.js';

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

/** Advance one Codex row against its running counters; a usage row without a time breaks the whole source. */
export function codexStep(state, row) {
  if (row.type === 'turn_context') state.model = row.payload?.model;
  const usage = row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info?.total_token_usage;
  if (!usage) return null;
  const model = typeof state.model === 'string' && state.model.trim() ? state.model : null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) { state.broken = true; return null; }
  if (input === null || output === null) {
    state.previous = undefined;
    return { at, ...unknownInputSplit(), inputTokens: null, outputTokens: null, model };
  }
  const previous = state.previous;
  // These are whole-source totals. The claim's anchored snapshot is subtracted before attribution.
  // A decreased field is independently unknown; never turn resets into positive spend.
  const deltaInput = !previous ? input : input >= previous.input ? input - previous.input : null;
  const deltaOutput = !previous ? output : output >= previous.output ? output - previous.output : null;
  const cached = count(usage.cached_input_tokens);
  // Codex includes cached reads in input: an inconsistent subset cannot establish a baseline.
  const read = cached !== null && cached <= input ? cached : null;
  const reportedRead = read !== null && (!previous || previous.read !== null && read >= previous.read) ? read - (previous?.read ?? 0) : null;
  // Cached reads are a subset of inclusive input in each trustworthy interval as well as cumulatively.
  const deltaRead = deltaInput !== null && reportedRead !== null && reportedRead > deltaInput ? null : reportedRead;
  // A reset or inconsistent cache interval cannot turn a derived fresh increase into proven spend.
  const deltaFresh = deltaInput !== null && deltaRead !== null ? deltaInput - deltaRead : null;
  state.previous = { input, output, read };
  return { at, freshInputTokens: deltaFresh, cacheReadInputTokens: deltaRead, cacheWriteInputTokens: null, inputTokens: deltaInput, outputTokens: deltaOutput, model };
}

/** Native cumulative Codex counters, differenced before claim attribution so duplicates add nothing. */
function codex(rows) {
  const state = {};
  const result = [];
  for (const row of rows) {
    const event = codexStep(state, row);
    if (state.broken) return [];
    if (event) result.push(event);
  }
  return result;
}

/** Fold one Claude row into its messages by native id; a streamed update replaces the earlier usage. */
export function claudeStep(messages, row) {
  const message = row.type === 'assistant' && row.message;
  if (!message || typeof message.id !== 'string' || !message.usage) return;
  const usage = message.usage;
  const raw = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const read = usage.cache_read_input_tokens === undefined ? 0 : count(usage.cache_read_input_tokens);
  const write = usage.cache_creation_input_tokens === undefined ? 0 : count(usage.cache_creation_input_tokens);
  const at = Date.parse(row.timestamp);
  const earlier = messages.get(message.id);
  if ([raw, output, read, write].includes(null) || !Number.isFinite(at) || !Number.isSafeInteger(raw + read + write)) {
    // Keep a valid streamed version; a new unreadable usage message is unknown, never zero.
    if (!earlier && Number.isFinite(at)) messages.set(message.id, { at, ...unknownInputSplit(), inputTokens: null, outputTokens: null, model: typeof message.model === 'string' && message.model.trim() ? message.model : null });
    return;
  }
  messages.set(message.id, { at: earlier?.at ?? at, inputTokens: raw + read + write, outputTokens: output,
    freshInputTokens: raw, cacheReadInputTokens: count(usage.cache_read_input_tokens), cacheWriteInputTokens: count(usage.cache_creation_input_tokens),
    model: typeof message.model === 'string' && message.model.trim() ? message.model : null });
}

/** Claude transcript message usage, deduplicated by native message id across streamed updates. */
function claude(rows) {
  const messages = new Map();
  for (const row of rows) claudeStep(messages, row);
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
