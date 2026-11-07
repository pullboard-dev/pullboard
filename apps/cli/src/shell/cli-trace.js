/**
 * The command trace: every pullboard run appends one JSON line to <git common dir>/pullboard/trace/<UTC date>.jsonl,
 * so an agent's behaviour, refusals and timings can be rebuilt from one folder shared by all worktrees [C7].
 * Tracing never fails or slows a command: one synchronous append, every error swallowed.
 */
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';

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
 * a Refused the command reported; `seat` is the registered agent id when known. It returns the line written, or
 * null when nothing could be written; it never throws.
 */
export function appendTrace({ argv, cwd, startedAt, status, error, refusal, seat = null, env = process.env, now = Date.now }) {
  try {
    const where = locate(cwd);
    if (!where) return null;
    const at = new Date(startedAt);
    const refused = refusal ?? (error && typeof error.code === 'string' && error.name === 'Refused' ? error : null);
    const item = itemOf(argv);
    const line = {
      at: at.toISOString(), agent: seat, model: firstEnv(MODEL_ENV, env), session: firstEnv(SESSION_ENV, env),
      worktree: where.root, branch: branchOf(where.gitDir), command: argv[0] ?? 'help', item,
      args: redactArgs(argv.slice(1)), exit: status,
      refusal: refused ? { code: refused.code, message: String(refused.message) } : null,
      error: error && !refused ? String(error.message ?? error) : undefined,
      ms: Math.max(0, now() - startedAt),
    };
    const dir = join(where.common, 'pullboard', 'trace');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${at.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`);
    return line;
  } catch { return null; }
}
