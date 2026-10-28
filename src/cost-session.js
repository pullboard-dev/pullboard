/** Locate only the caller's native session and keep transcript bytes on its machine [N2]. */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeUsage } from './cost-provider.js';

/** Hash a private prefix so truncation or replacement never becomes historical spend. */
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

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

/** Add provider counts without silently rounding overflow or masking an unknown field. */
function add(left, right) {
  return left !== null && right !== null && Number.isSafeInteger(left + right) ? left + right : null;
}

/** Read cumulative per-model native totals together with a private append-only source anchor. */
export function sessionSnapshot(source, previous, cutoff = Infinity) {
  if (!source) return null;
  try {
    const stat = lstatSync(source.file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const bytes = readFileSync(source.file);
    if (previous && (stat.dev !== previous.dev || stat.ino !== previous.ino || bytes.length < previous.bytes || hash(bytes.subarray(0, previous.bytes)) !== previous.sha256)) return null;
    const usage = nativeUsage(source, bytes, cutoff);
    // Readable bytes without a native usage record establish no counter baseline, including an empty file.
    if (!usage) return null;
    const events = usage.filter((event) => event.at <= cutoff);
    const totals = Object.create(null);
    for (const event of events) {
      const model = event.model ?? 'unknown';
      const total = totals[model] ?? { inputTokens: 0, outputTokens: 0 };
      totals[model] = { inputTokens: add(total.inputTokens, event.inputTokens), outputTokens: add(total.outputTokens, event.outputTokens) };
    }
    return { totals, model: events.at(-1)?.model ?? null, dev: stat.dev, ino: stat.ino, bytes: bytes.length, sha256: hash(bytes) };
  } catch { return null; }
}

/** Difference only a verified claim anchor; a new or reset cumulative counter is unknown. */
export function usageDifference(before, after, fallbackModel) {
  // Older private ledgers may retain an empty-file snapshot; that never established a native counter.
  if (!before || !after || !Object.keys(before.totals).length || !Object.keys(after.totals).length) {
    return [{ model: fallbackModel, inputTokens: null, outputTokens: null }];
  }
  const models = new Set([...Object.keys(before.totals), ...Object.keys(after.totals)]);
  return [...models].map((model) => {
    const old = before.totals[model] ?? { inputTokens: 0, outputTokens: 0 };
    const current = after.totals[model];
    /** A missing or decreasing field has no trustworthy spend delta. */
    const difference = (name) => current?.[name] !== null && old[name] !== null && Number.isSafeInteger(current?.[name] - old[name]) && current[name] >= old[name] ? current[name] - old[name] : null;
    return { model, inputTokens: difference('inputTokens'), outputTokens: difference('outputTokens') };
  });
}

/** Retain a dollar report through metadata appends only while both native prefixes still match. */
export function sameUsageAnchor(left, right, source) {
  if (!left || !right || left.dev !== right.dev || left.ino !== right.ino || right.bytes < left.bytes
      || JSON.stringify(left.totals) !== JSON.stringify(right.totals)) return false;
  if (!source) return left.bytes === right.bytes && left.sha256 === right.sha256;
  try {
    const stat = lstatSync(source.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== right.dev || stat.ino !== right.ino) return false;
    const bytes = readFileSync(source.file);
    return bytes.length >= right.bytes && hash(bytes.subarray(0, left.bytes)) === left.sha256
      && hash(bytes.subarray(0, right.bytes)) === right.sha256;
  } catch { return false; }
}
