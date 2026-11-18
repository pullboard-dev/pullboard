/**
 * The command trace: every pullboard run appends one JSON line to <git common dir>/pullboard/trace/<UTC date>.jsonl,
 * so an agent's behaviour, refusals and timings can be rebuilt from one folder shared by all worktrees [C7].
 * Tracing never fails or slows a command: one synchronous append, every error swallowed.
 */
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';

/** The store file name for the record held under a key, with its extension; local so a cold command loads one module fewer (closure-budget) [C7]. */
function storeName(key, ext = '.json') { return key + ext; }

/** Environment names that carry an agent session id (kept literal so a trace loads no discovery module). */
const SESSION_ENV = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'];
/** Environment names that carry the running model, first set wins. */
const MODEL_ENV = ['PULLBOARD_MODEL', 'ANTHROPIC_MODEL', 'CLAUDE_MODEL', 'CODEX_MODEL', 'OPENAI_MODEL'];
/** A flag whose name matches this has its value dropped from the trace. */
const SECRET_NAME = /token|key|secret|password/iu;

/** The first environment value set among names, or null. */
function firstEnv(names, env) {
  for (const name of names) if (env[name]) return env[name];
  return null;
}

/**
 * Args with the values of secret-named flags dropped: `--token x` and `--token=x` both lose x, so no value of
 * anything named token, key, secret or password reaches disk.
 */
export function redactArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const flag = /^--?([^=]+)(=.*)?$/u.exec(arg);
    if (!flag || !SECRET_NAME.test(flag[1])) { out.push(arg); continue; }
    if (flag[2] !== undefined) { out.push(`--${flag[1]}=[redacted]`); continue; }
    out.push(arg);
    if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('-')) { out.push('[redacted]'); i += 1; }
  }
  return out;
}

/** Flags whose value names an item, as in `next --verify 3214`. */
const ITEM_FLAGS = new Set(['--verify', '--item', '--after']);

/**
 * The item id a command names: the first bare number after the command, or the value of an item flag such as
 * `--verify`. A number that is the value of any other flag (`--wait 30`) is not an item id.
 */
export function itemOf(argv) {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const inline = /^(--[^=]+)=#?([1-9][0-9]*)$/u.exec(arg);
    if (inline && ITEM_FLAGS.has(inline[1])) return Number(inline[2]);
    const bare = /^#?([1-9][0-9]*)$/u.exec(arg)?.[1];
    const prev = i > 1 ? String(argv[i - 1]) : '';
    if (bare && ITEM_FLAGS.has(prev)) return Number(bare);
    if (bare && !(prev.startsWith('--') && !prev.includes('='))) return Number(bare);
  }
  return null;
}

/** The worktree root, its git dir and the common git dir for cwd, or null outside a repository. */
function locate(cwd) {
  let root = resolve(cwd);
  while (!existsSync(join(root, '.git'))) { const parent = dirname(root); if (parent === root) return null; root = parent; }
  const marker = join(root, '.git');
  let gitDir = marker;
  if (!statSync(marker).isDirectory()) {
    const match = /^gitdir:\s*(.+)\s*$/u.exec(readFileSync(marker, 'utf8').trim());
    if (!match) return null;
    gitDir = resolve(root, match[1]);
  }
  const commonFile = join(gitDir, 'commondir');
  const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
  return { root, gitDir, common };
}

/** The checked-out branch name from HEAD, or null when detached or unreadable. */
function branchOf(gitDir) {
  try { return /^ref: refs\/heads\/(.+)$/mu.exec(readFileSync(join(gitDir, 'HEAD'), 'utf8'))?.[1] ?? null; }
  catch { return null; }
}

/**
 * Append one trace line for a finished command. `status` is the exit code, `error` an uncaught throw and `refusal`
 * a Refused the command reported; `seat` is the registered agent id when known; `why` is the agent's stated intent. It returns the line written, or
 * null when nothing could be written; it never throws.
 */
export function appendTrace({ argv, cwd, startedAt, status, error, refusal, seat = null, why = null, env = process.env, now = Date.now }) {
  try {
    const where = locate(cwd);
    if (!where) return null;
    const at = new Date(startedAt);
    const refused = refusal ?? (error && typeof error.code === 'string' && error.name === 'Refused' ? error : null);
    const item = itemOf(argv);
    const line = {
      at: at.toISOString(), agent: seat, model: firstEnv(MODEL_ENV, env), session: firstEnv(SESSION_ENV, env),
      worktree: where.root, branch: branchOf(where.gitDir), command: argv[0] ?? 'help', item,
      args: redactArgs(argv.slice(1)), why, exit: status,
      refusal: refused ? { code: refused.code, message: String(refused.message) } : null,
      error: error && !refused ? String(error.message ?? error) : undefined,
      ms: Math.max(0, now() - startedAt),
    };
    const dir = join(where.common, 'pullboard', 'trace');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${storeName(at.toISOString().slice(0, 10), '.jsonl')}`), `${JSON.stringify(line)}\n`);
    return line;
  } catch { return null; }
}

/** Unit lengths in milliseconds for a --since value such as 90m, 2h or 1d. */
const SINCE_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The epoch milliseconds a --since value reaches back to from `now`, or null when the value is not <number><s|m|h|d>. */
export function sinceCutoff(value, now = Date.now()) {
  const match = /^([1-9][0-9]*)([smhd])$/u.exec(String(value));
  return match ? now - Number(match[1]) * SINCE_UNITS[match[2]] : null;
}

/** Every parsed trace line under the shared trace folder of a git common dir, oldest file first; unreadable lines are skipped. */
export function readTraceLines(commonDir) {
  const dir = join(commonDir, 'pullboard', 'trace');
  let names;
  try { names = readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort(); } catch { return []; }
  const lines = [];
  for (const name of names) {
    for (const text of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!text) continue;
      try { lines.push(JSON.parse(text)); } catch { /* A torn line is skipped; the rest of the day still reads. */ }
    }
  }
  return lines;
}

/** The first non-empty string among the named keys of a board event's detail, or '' (the event's stated why). */
function eventWhy(detail) {
  for (const key of ['reason', 'note', 'text', 'message', 'title']) if (typeof detail?.[key] === 'string' && detail[key]) return detail[key];
  return '';
}

/**
 * The one line a `lapsed` job step prints: the runner that held the earlier claim, its attempt, when its lease ended and
 * the last step it wrote. A payload this reader cannot parse prints as before. Why: a lapse left no readable reason, so six
 * claims of one job looked like a runner that never started [C7,#9248].
 */
function lapseWhy(row) {
  let lapse;
  try { lapse = JSON.parse(row.payload); } catch { lapse = null; }
  const at = value => Number.isFinite(value) ? new Date(value).toISOString() : 'unknown';
  if (!lapse || typeof lapse !== 'object') return `job ${String(row.job).slice(0, 8)} attempt ${row.attempt}${row.payload ? ` ${row.payload}` : ''}`;
  return `job ${String(row.job).slice(0, 8)} lapsed: runner ${lapse.runner ?? 'unknown'} attempt ${lapse.attempt ?? 'unknown'} lease ended ${at(lapse.leaseUntil)} last step ${lapse.lastStep ?? 'none'} at ${at(lapse.lastAt)}`;
}

/**
 * One timeline from trace lines and board event rows, in time order, one entry per call or event: time, source
 * (call or event), agent, command, item, outcome (ok, the refusal code, or error), duration in ms (null for an event)
 * and why (the refusal message, or the event's reason or note). A subject that is an item id keeps every agent's
 * entries on that item; any other subject keeps that agent's entries only.
 */
export function traceTimeline({ lines, events, subject, since = null, jobs = [] }) {
  const item = /^#?([1-9][0-9]*)$/u.exec(String(subject))?.[1];
  const wanted = item ? Number(item) : null;
  const entries = [];
  for (const line of lines) {
    if (wanted !== null ? line.item !== wanted : line.agent !== subject) continue;
    entries.push({
      time: line.at, source: 'call', agent: line.agent, command: line.command, item: line.item ?? null,
      outcome: line.refusal?.code ?? (line.error ? 'error' : line.exit === 0 ? 'ok' : `exit ${line.exit}`),
      ms: line.ms ?? null, why: line.refusal?.message ?? line.error ?? (typeof line.why === 'string' ? line.why : ''),
    });
  }
  for (const row of events) {
    if (wanted !== null ? row.item_id !== wanted : row.event_by !== subject) continue;
    let detail = {};
    try { detail = JSON.parse(row.event_detail); } catch { /* A detail that is not JSON has no stated why. */ }
    entries.push({ time: row.event_at, source: 'event', agent: row.event_by, command: row.event_kind, item: row.item_id ?? null, outcome: 'ok', ms: null, why: eventWhy(detail) });
  }
  // A gate job's steps are the item's internals: each step is one entry with its ms time, and `ms` is the gap since the
  // job's previous step, so a long silence shows as a long gap [C7].
  if (wanted !== null) {
    const previous = new Map();
    for (const row of jobs.filter(job => job.item === wanted).sort((left, right) => left.at - right.at || left.id - right.id)) {
      const gap = previous.has(row.job) ? row.at - previous.get(row.job) : null;
      previous.set(row.job, row.at);
      entries.push({ time: new Date(row.at).toISOString(), source: 'job', agent: row.owner ?? 'gate', command: `${row.kind}:${row.step}`, item: row.item,
        outcome: 'ok', ms: gap, why: row.step === 'lapsed' ? lapseWhy(row) : `job ${String(row.job).slice(0, 8)} attempt ${row.attempt}${row.payload ? ` ${row.payload}` : ''}` });
    }
  }
  const kept = since === null ? entries : entries.filter(entry => Date.parse(entry.time) >= since);
  return kept.sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

/** One printable line for a timeline entry: time, command, item, outcome, duration and why. */
export function traceLine(entry) {
  const duration = entry.ms === null ? '-' : `${entry.ms}ms`;
  return [entry.time, entry.command, entry.item === null ? '-' : `#${entry.item}`, entry.outcome, duration, String(entry.why).replace(/\s+/gu, ' ').trim() || '-'].join('  ');
}

/**
 * Every gate job step on the board with its job's item, attempt and lease owner, oldest first; empty on a board that
 * has no job tables yet. Why: the trace shows a gate's internals beside the item's calls and events [C7].
 *
 * With `runs` (runs_store on) the steps come from the runs file, read only, and each finished run adds one outcome step
 * from the board's run row [B2,#9013].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync | null } | null }} [options]
 * @returns {{ id: number, job: string, step: string, at: number, payload: string, kind: string, item: number, attempt: number, owner: string|null }[]}
 */
export function readJobSteps(db, { runs = null } = {}) {
  if (runs) {
    const live = runs.db ? readJobSteps(runs.db) : [];
    let outcomes = [];
    try {
      outcomes = db.prepare("SELECT rowid AS n, * FROM run WHERE run_state != 'queued' AND run_item IS NOT NULL ORDER BY run_updated, rowid").all()
        .map(row => ({ id: 1e9 + row.n, job: row.run_job, step: `outcome:${row.run_outcome ?? row.run_state}`, at: row.run_updated, payload: '', kind: row.run_kind, item: row.run_item, attempt: row.run_attempt, owner: null }));
    } catch { outcomes = []; }
    return [...live, ...outcomes].sort((left, right) => left.at - right.at || left.id - right.id);
  }
  let rows;
  try {
    rows = db.prepare(`SELECT s.job_step_id AS id, s.job_step_job AS job, s.job_step_name AS step, s.job_step_at AS at, s.job_step_payload AS payload,
      j.job_kind AS kind, j.job_item AS item, j.job_attempt AS attempt, j.job_lease_owner AS owner FROM job_step s JOIN job j ON j.job_id = s.job_step_job
      WHERE j.job_item IS NOT NULL ORDER BY s.job_step_at, s.job_step_id`).all();
  } catch { return []; }
  // A step's payload is shown short, and a hand-off record is not a timing fact, so it is left out.
  return rows.map(row => ({ ...row, payload: row.payload === '{}' || String(row.payload).includes('"record"') ? '' : String(row.payload).slice(0, 200) }));
}
