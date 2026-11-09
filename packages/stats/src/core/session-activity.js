/**
 * Agent session logs folded into activity segments and token buckets for the pipeline ledger [C7,N2].
 *
 * A Claude transcript or Codex rollout is read row by row into: segments (from, to, what the agent was doing, its model,
 * its working folder) and 15-second token buckets (model, folder, fresh, cache read, cache write and output tokens).
 * The fold keeps a small JSON state so a later read continues from a byte offset instead of starting over; that is what
 * keeps `pullboard ledger` under a second on hundreds of megabytes of logs.
 *
 * Why buckets rather than one record per message: a busy fleet writes tens of thousands of usage rows an hour, and the
 * ledger only needs to know which seat, role and item a token belongs to, which a 15-second bucket answers.
 */

/** Bucket width for token records. */
export const BUCKET_MS = 15_000;

/** A model turn longer than this with no row in between is counted as idle beyond the cap. */
const THINKING_CAP_MS = 10 * 60_000;

/** Records older than this are dropped from a cached fold. */
export const KEEP_MS = 8 * 24 * 3_600_000;

/**
 * What a shell command or tool call was: submit, waiting, tests, another pullboard command, or another command.
 *
 * @param {string} name - the tool name
 * @param {string} command - the shell text, when it is a shell call
 * @returns {string}
 */
export function commandKind(name, command = '') {
  const text = String(command);
  if (/pullboard(?:\.js)?\s+submit\b/u.test(text)) return 'submit';
  if (/pullboard(?:\.js)?\s+next\b[^\n]*--wait/u.test(text) || /(?:^|[;&|]\s*)sleep\s/u.test(text) || ['Agent', 'Task', 'TaskOutput', 'Monitor', 'SendMessage'].includes(name)) return 'waiting';
  if (/run-tests|node\s+--test|pullboard(?:\.js)?\s+test\b|npm\s+(?:run\s+)?test\b/u.test(text)) return 'tests';
  if (/pullboard/u.test(text)) return 'pullboard';
  return 'command';
}

/**
 * Where a shell command says it works, when that differs from the session's own folder: a seat wrapper script
 * (`seat-<name>.sh`, which cds into the seat's worktree) gives `seat:<name>`, and a leading `cd <absolute path>` gives
 * that path. Null when the command names neither.
 *
 * Why: the coordinator's builder and unblocker subagents run in the main checkout and reach their seat's worktree
 * through a wrapper or a cd, so the transcript's own working folder would credit all their tokens to the coordinator.
 *
 * @param {string} command
 * @returns {string|null}
 */
export function commandPlace(command) {
  const text = String(command ?? '');
  const seat = /(?:^|[\s/'"])seat-([A-Za-z0-9._-]+?)\.sh\b/u.exec(text);
  if (seat) return `seat:${seat[1]}`;
  const cd = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\/[^\s;&|]+))/u.exec(text);
  const path = cd ? (cd[1] ?? cd[2] ?? cd[3]) : null;
  return path && path.startsWith('/') ? path.replace(/\/+$/u, '') : null;
}

/** The folder a fold's records belong to: the last place a command named, else the session's own folder. */
function place(state) {
  return state.where ?? state.cwd;
}

/** A new fold state for one session file. */
export function newFold(provider) {
  return { provider, at: null, label: null, cwd: null, where: null, model: null, calls: {}, lastId: null, lastUsage: null, turn: false, previous: null, records: false };
}

/** Accept a finite nonnegative token count, else 0. */
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Append a segment, merging it into the last one when it continues it with the same kind, model and folder.
 *
 * @param {object[]} segments
 * @param {number} s
 * @param {number} e
 * @param {string} k
 * @param {string|null} m
 * @param {string|null} c
 */
export function pushSegment(segments, s, e, k, m, c) {
  if (!(e > s)) return;
  const last = segments.at(-1);
  if (last && last.k === k && last.m === m && last.c === c && last.e === s) { last.e = e; return; }
  segments.push({ s, e, k, m, c });
}

/**
 * Relabel [s, e] in already-folded segments as a command kind: Codex reports a command only when it completes, with
 * its duration, so the time it ran was first folded as thinking.
 *
 * @param {object[]} segments
 * @param {number} s
 * @param {number} e
 * @param {string} kind
 */
export function overlay(segments, s, e, kind) {
  let index = segments.length - 1;
  while (index >= 0 && segments[index].e > s) index -= 1;
  const tail = segments.splice(index + 1);
  for (const segment of tail) {
    if (segment.k === 'idle' || segment.e <= s || segment.s >= e) { pushSegment(segments, segment.s, segment.e, segment.k, segment.m, segment.c); continue; }
    pushSegment(segments, segment.s, Math.max(segment.s, s), segment.k, segment.m, segment.c);
    pushSegment(segments, Math.max(segment.s, s), Math.min(segment.e, e), kind, segment.m, segment.c);
    pushSegment(segments, Math.min(segment.e, e), segment.e, segment.k, segment.m, segment.c);
  }
}

/**
 * Add tokens to the bucket for an instant, model and folder; a negative count takes back an earlier streamed copy.
 *
 * @param {Map<string, object>|object[]} buckets - an array of bucket rows; the newest are at the end
 * @param {number} at
 * @param {string|null} model
 * @param {string|null} cwd
 * @param {{ fresh: number, read: number, write: number, out: number }} usage
 * @param {number} [sign]
 */
export function addBucket(buckets, at, model, cwd, usage, sign = 1) {
  const t = Math.floor(at / BUCKET_MS) * BUCKET_MS;
  let row = null;
  for (let index = buckets.length - 1; index >= 0 && index >= buckets.length - 8; index -= 1) {
    const bucket = buckets[index];
    if (bucket.t === t && bucket.m === model && bucket.c === cwd) { row = bucket; break; }
  }
  if (!row) { row = { t, m: model, c: cwd, fresh: 0, read: 0, write: 0, out: 0 }; buckets.push(row); }
  row.fresh += sign * usage.fresh; row.read += sign * usage.read; row.write += sign * usage.write; row.out += sign * usage.out;
}

/**
 * Close the open interval of a fold at `at` with the label its last row left, capping a long model turn.
 *
 * @param {ReturnType<typeof newFold>} state
 * @param {object[]} segments
 * @param {number} at
 * @param {string} label
 */
function close(state, segments, at, label) {
  if (state.at === null || !(at > state.at)) return;
  if (label === 'thinking' && at - state.at > THINKING_CAP_MS) {
    pushSegment(segments, state.at, state.at + THINKING_CAP_MS, 'thinking', state.model, place(state));
    pushSegment(segments, state.at + THINKING_CAP_MS, at, 'idle', state.model, place(state));
    return;
  }
  pushSegment(segments, state.at, at, label, state.model, place(state));
}

/**
 * Fold one Claude transcript row: tool calls are command time until their result, an assistant row that ends a turn
 * leaves idle time until the next prompt, and everything else is the model thinking. Usage is deduplicated by message
 * id: a streamed copy replaces the earlier one.
 *
 * @param {ReturnType<typeof newFold>} state
 * @param {object} row
 * @param {{ segments: object[], buckets: object[] }} out
 */
export function foldClaude(state, row, out) {
  const at = Date.parse(row?.timestamp);
  if (!Number.isFinite(at)) return;
  const type = row.type;
  if (type !== 'assistant' && type !== 'user') return;
  const content = Array.isArray(row.message?.content) ? row.message.content : [];
  const results = type === 'user' ? content.filter(block => block?.type === 'tool_result') : [];
  let label = state.label ?? 'thinking';
  if (label === 'end') label = type === 'user' && !results.length ? 'idle' : 'thinking';
  close(state, out.segments, at, label);
  if (typeof row.cwd === 'string') state.cwd = row.cwd;
  state.at = Math.max(state.at ?? at, at);
  if (type === 'assistant') {
    const message = row.message ?? {};
    if (typeof message.model === 'string' && message.model && !message.model.startsWith('<')) state.model = message.model;
    const uses = content.filter(block => block?.type === 'tool_use');
    for (const use of uses) {
      state.calls[use.id] = commandKind(use.name, use.name === 'Bash' ? use.input?.command : '');
      const where = use.name === 'Bash' ? commandPlace(use.input?.command) : null;
      if (where) state.where = where;
    }
    if (uses.length) state.label = uses.map(use => state.calls[use.id]).find(kind => kind === 'waiting') ?? state.calls[uses.at(-1).id];
    else state.label = message.stop_reason === 'end_turn' || content.some(block => block?.type === 'text') ? 'end' : 'thinking';
    if (message.usage && typeof message.id === 'string') {
      const usage = { fresh: count(message.usage.input_tokens), read: count(message.usage.cache_read_input_tokens),
        write: count(message.usage.cache_creation_input_tokens), out: count(message.usage.output_tokens) };
      if (state.lastId === message.id && state.lastUsage) addBucket(out.buckets, state.lastUsage.at, state.lastUsage.model, state.lastUsage.cwd, state.lastUsage, -1);
      const first = state.lastId === message.id && state.lastUsage ? state.lastUsage.at : at;
      addBucket(out.buckets, first, state.model, place(state), usage);
      state.lastId = message.id;
      state.lastUsage = { ...usage, at: first, model: state.model, cwd: place(state) };
    }
  } else {
    for (const result of results) delete state.calls[result.tool_use_id];
    const pending = Object.values(state.calls);
    state.label = pending.length ? pending.at(-1) : 'thinking';
  }
}

/**
 * Fold one Codex rollout row: inside a task turn the agent is thinking unless a command ran, between turns it is idle.
 * Tokens come from per-response usage records when the rollout has them, else from differenced cumulative counters.
 *
 * @param {ReturnType<typeof newFold>} state
 * @param {object} row
 * @param {{ segments: object[], buckets: object[] }} out
 */
export function foldCodex(state, row, out) {
  const at = Date.parse(row?.timestamp);
  if (!Number.isFinite(at)) return;
  const payload = row.payload ?? {};
  close(state, out.segments, at, state.turn ? 'thinking' : 'idle');
  state.at = Math.max(state.at ?? at, at);
  if (row.type === 'session_meta' && typeof payload.cwd === 'string') state.cwd = payload.cwd;
  if (row.type === 'turn_context') {
    if (typeof payload.model === 'string' && payload.model) state.model = payload.model;
    if (typeof payload.cwd === 'string') state.cwd = payload.cwd;
  }
  if (row.type === 'event_msg' && payload.type === 'task_started') state.turn = true;
  if (row.type === 'event_msg' && payload.type === 'task_complete') state.turn = false;
  if (row.type === 'event_msg' && payload.type === 'item_completed' && payload.item?.type === 'CommandExecution') {
    const item = payload.item;
    const seconds = (item.duration?.secs ?? 0) + (item.duration?.nanos ?? 0) / 1e9;
    const command = (Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '')).slice(-400);
    if (seconds > 0) overlay(out.segments, at - seconds * 1000, at, commandKind('shell', command));
  }
  if (row.type === 'token_usage_record' && payload.usage) {
    state.records = true;
    const usage = payload.usage;
    const input = count(usage.input_tokens), read = Math.min(input, count(usage.cached_input_tokens));
    addBucket(out.buckets, at, state.model, state.cwd, { fresh: input - read, read, write: count(usage.cache_write_input_tokens), out: count(usage.output_tokens) });
  } else if (!state.records && row.type === 'event_msg' && payload.type === 'token_count' && payload.info?.total_token_usage) {
    const total = payload.info.total_token_usage;
    const now = { input: count(total.input_tokens), read: count(total.cached_input_tokens), write: count(total.cache_write_input_tokens), out: count(total.output_tokens) };
    const previous = state.previous;
    // Cumulative counters: a decrease is a reset, never negative spend.
    const delta = name => !previous ? now[name] : now[name] >= previous[name] ? now[name] - previous[name] : 0;
    const input = delta('input'), read = Math.min(input, delta('read'));
    addBucket(out.buckets, at, state.model, state.cwd, { fresh: input - read, read, write: delta('write'), out: delta('out') });
    state.previous = now;
  }
}

/**
 * Fold a chunk of JSONL text into a session's state and records.
 *
 * @param {ReturnType<typeof newFold>} state
 * @param {string} text - whole lines
 * @param {{ segments: object[], buckets: object[] }} out
 */
export function foldText(state, text, out) {
  const fold = state.provider === 'codex' ? foldCodex : foldClaude;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    if (end > start) {
      let row = null;
      try { row = JSON.parse(text.slice(start, end)); } catch { /* a torn or foreign line is skipped */ }
      if (row) fold(state, row, out);
    }
    start = end + 1;
  }
}

/**
 * The open tail of a fold as of `now`: the interval since its last row, so a live session's current activity counts.
 * A fold whose last row is older than the cap ended at that row and has no tail.
 *
 * @param {ReturnType<typeof newFold>} state
 * @param {number} now
 * @returns {object[]}
 */
export function openTail(state, now) {
  if (state.at === null || !(now > state.at)) return [];
  // A session silent past the cap has ended or been abandoned: it is not counted as idle until now.
  if (now - state.at > THINKING_CAP_MS) return [];
  const label = state.provider === 'codex' ? (state.turn ? 'thinking' : 'idle') : state.label === 'end' || !state.label ? 'idle' : state.label;
  const segments = [];
  close({ ...state }, segments, now, label);
  return segments;
}
