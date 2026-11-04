/** Locate only the caller's native session and keep transcript bytes on its machine [N2]. */
import { lstatSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cursorSnapshot } from './cost-cursor.js';
import { SPLIT_COUNTS } from './cost-read.js';
import { unknownInputSplit } from './cost-read.js';

/** Search native directories without following symlinks or reading other sessions' contents. */
function findSession(directory, identity, provider) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findSession(file, identity, provider);
      if (found) return found;
    } else if (entry.isFile() && (provider === 'claude' ? entry.name === `${identity}.jsonl` : entry.name.endsWith(`-${identity}.jsonl`))) return file;
  }
  return null;
}

/** Native identity is used only to locate a file; neither it nor the file path is shared. */
export function sessionSource(environment = process.env) {
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
 * Read cumulative per-model native totals together with a private append-only source anchor.
 * A log is trusted by its file identity and length: a replaced or truncated file stays unknown. With `cursors`
 * (the private ledger's per-file offsets) only bytes appended since the last checkpoint are read.
 */
export function sessionSnapshot(source, previous, cutoff = Infinity, cursors) {
  if (!source) return null;
  try {
    const stat = lstatSync(source.file);
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
