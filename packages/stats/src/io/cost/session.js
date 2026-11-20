/** Locate only the caller's native session and keep transcript bytes on its machine [N2]. */
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { cursorSnapshot } from './cursor.js';
import { SPLIT_COUNTS } from './usage.js';
import { unknownInputSplit } from './usage.js';
import { allowanceFromRows } from './usage.js';
import { storeName } from '../store-names.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

/** The variables a seat wrapper exports to name the transcript its tokens land in: one file, or a folder whose newest transcript is meant. */
export const AGENT_TRANSCRIPT_ENV = Object.freeze(['PULLBOARD_SESSION_LOG', 'PULLBOARD_SESSION_DIR']);

/** Search native directories without following symlinks or reading other sessions' contents. */
function findSession(directory, identity, provider) {
  let entries;
  try { entries = fs.list(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findSession(file, identity, provider);
      if (found) return found;
    } else if (entry.isFile() && (provider === 'claude' ? entry.name === storeName(identity, '.jsonl') : entry.name.endsWith(`-${storeName(identity, '.jsonl')}`))) return file;
  }
  return null;
}

/** Which provider's log format a declared transcript has: Codex only when a Codex id is the one the shell carries. */
function declaredProvider(environment) {
  return !environment.CLAUDE_CODE_SESSION_ID && (environment.CODEX_THREAD_ID || environment.CODEX_SESSION_ID) ? 'codex' : 'claude';
}

/** The regular, unlinked file at an absolute path, or null. */
function regularFile(file) {
  try {
    const stat = fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch { return null; }
}

/** The newest regular `.jsonl` directly inside a folder, or null. */
function newestTranscript(directory) {
  let newest = null;
  let entries;
  try { entries = fs.list(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = join(directory, entry.name);
    const stat = regularFile(file);
    if (stat && (!newest || stat.mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs: stat.mtimeMs };
  }
  return newest?.file ?? null;
}

/**
 * A transcript the seat wrapper names, ahead of any id lookup: an exact `PULLBOARD_SESSION_LOG`, else the newest
 * transcript in `PULLBOARD_SESSION_DIR`. Why: a wrapper's fixed session id never names a real file, and a sub-agent
 * writes to its own file that no id the wrapper holds can find.
 */
function declaredSource(environment) {
  const [log, directory] = AGENT_TRANSCRIPT_ENV.map((name) => environment[name]);
  const provider = declaredProvider(environment);
  if (typeof log === 'string' && isAbsolute(log) && regularFile(log)) return { provider, file: log };
  const file = typeof directory === 'string' && isAbsolute(directory) ? newestTranscript(directory) : null;
  return file ? { provider, file } : null;
}

/** Native identity is used only to locate a file; neither it nor the file path is shared. */
export function sessionSource(environment = process.env) {
  const declared = declaredSource(environment);
  if (declared) return declared;
  const provider = environment.CLAUDE_CODE_SESSION_ID ? 'claude' : 'codex';
  const identity = provider === 'claude' ? environment.CLAUDE_CODE_SESSION_ID : environment.CODEX_THREAD_ID ?? environment.CODEX_SESSION_ID;
  if (typeof identity !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(identity)) return null;
  const directory = provider === 'claude'
    ? join(environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
    : join(environment.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const file = findSession(directory, identity, provider);
  return file ? { provider, file } : null;
}

/**
 * Why no transcript resolved. A Claude session id with no matching file is a wrapper that fixed its id (or never
 * declared a transcript), a visible defect rather than a silent unavailable session.
 */
export function missingSessionReason(environment = process.env) {
  return environment.CLAUDE_CODE_SESSION_ID ? 'wrapper-session-id-fixed' : 'native-session-unavailable';
}

/**
 * Read cumulative per-model native totals together with a private append-only source anchor.
 * A log is trusted by its file identity and length: a replaced or truncated file stays unknown. With `cursors`
 * (the private ledger's per-file offsets) only bytes appended since the last checkpoint are read.
 */
export function sessionSnapshot(source, previous, cutoff = Infinity, cursors) {
  if (!source) return null;
  try {
    const stat = fs.lstat(source.file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (previous && (stat.dev !== previous.dev || stat.ino !== previous.ino || stat.size < previous.bytes)) return null;
    // Readable bytes without a native usage record establish no counter baseline, including an empty file.
    return cursorSnapshot(source, stat, cutoff, cursors);
  } catch { return null; }
}

/** Difference only a verified claim anchor; a new or reset cumulative counter is unknown. */
export function usageDifference(before, after, fallbackModel) {
  // Older private ledgers may retain an empty-file snapshot; that never established a native counter.
  if (!before || !after || !Object.keys(before.totals).length || !Object.keys(after.totals).length) {
    return [{ model: fallbackModel, ...unknownInputSplit(), inputTokens: null, outputTokens: null }];
  }
  const models = new Set([...Object.keys(before.totals), ...Object.keys(after.totals)]);
  return [...models].map((model) => {
    const old = before.totals[model] ?? Object.fromEntries(['inputTokens', 'outputTokens', ...SPLIT_COUNTS].map(name => [name, 0]));
    const current = after.totals[model];
    /** A missing or decreasing field has no trustworthy spend delta. */
    const difference = (name) => current?.[name] !== null && old[name] !== null && Number.isSafeInteger(current?.[name] - old[name]) && current[name] >= old[name] ? current[name] - old[name] : null;
    return { model, ...Object.fromEntries(['inputTokens', 'outputTokens', ...SPLIT_COUNTS].map(name => [name, difference(name)])) };
  });
}

/** A seat's allowance read from its Codex session file; an unreadable file or one without rate limits is unknown [C7]. */
export function seatAllowance(file) {
  let text;
  try { text = fs.readFile(file, 'utf8'); } catch { return { known: false }; }
  const rows = [];
  for (const line of text.split('\n')) {
    try { rows.push(JSON.parse(line)); } catch { /* a torn or blank line carries no allowance */ }
  }
  return allowanceFromRows(rows);
}
