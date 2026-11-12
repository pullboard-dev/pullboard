/** Pure rules of the full-suite census: how many shards to cut and what verdict each file gets from its shard's log [C7]. */

/** Most shards cut for one runner, however many slots it has: a few big shards pay the runner's source prepare once each. */
export const SHARDS_PER_RUNNER = 3;

/**
 * Shards for a census: each registered runner takes up to SHARDS_PER_RUNNER of them, fewer when it has fewer slots, so
 * a one-slot runner gets one. No runner at all gives one shard for this machine.
 *
 * @param {Array<{ slots?: number }>} runners
 * @param {number} [perRunner]
 * @returns {number}
 */
export function censusShardCount(runners, perRunner = SHARDS_PER_RUNNER) {
  let count = 0;
  for (const runner of runners ?? []) count += Math.max(1, Math.min(perRunner, Number.isFinite(runner?.slots) ? Math.floor(runner.slots) : 1));
  return Math.max(1, count);
}

/** The shard-header line runLandingShards writes before each attempt's output: `# landing shard 2/9 attempt 1 on host: green in 4 ms`. */
const HEADER = /^# landing shard (\d+\/\d+) attempt (\d+) on (\S+): (\w+)(?: \([^)]*\))? in \d+ ms/u;

/**
 * Read a shard-attempt header; null for any other line.
 *
 * @param {string} line
 * @returns {{ label: string, attempt: number, host: string, status: string }|null}
 */
export function parseShardHeader(line) {
  const match = HEADER.exec(line);
  return match ? { label: match[1], attempt: Number(match[2]), host: match[3], status: match[4] } : null;
}

/** Whether an attempt status is the shard's last word (an infrastructure attempt may be queued again). */
export const finalStatus = status => status === 'green' || status === 'red' || status === 'refused' || status === 'stopped';

/**
 * Failed leaf cases per planned file, read from a shard's TAP. A failing case carries the `location:` of its file,
 * absolute inside the runner's checkout, so a planned file owns a case when its path ends the location. Parents that
 * fail only because a child did (subtestsFailed) are not cases.
 *
 * @param {string} output
 * @param {string[]} files
 * @returns {Map<string, string[]>}
 */
export function tapFailures(output, files) {
  const failed = new Map();
  let active = null;
  const close = () => {
    if (!active || active.type === 'subtestsFailed' || !active.path) return;
    const file = files.find(candidate => active.path === candidate || active.path.endsWith(`/${candidate}`));
    if (file) failed.set(file, [...(failed.get(file) ?? []), active.name]);
  };
  for (const raw of String(output).split('\n')) {
    const row = /^(\s*)(not ok|ok)\s+\d+\s+-\s+(.*)$/u.exec(raw);
    if (row) { close(); active = row[2] === 'not ok' ? { name: row[3].replace(/\s+#\s*(?:SKIP|TODO)\b.*$/iu, ''), indent: row[1].length, path: null, type: null } : null; continue; }
    if (!active) continue;
    const field = /^(\s*)(location|failureType):\s*(.*?)\s*$/u.exec(raw);
    if (!field || field[1].length !== active.indent + 2) continue;
    const value = field[3].replace(/^(['"])(.*)\1$/u, '$2');
    if (field[2] === 'location') active.path = value.replace(/:\d+(?::\d+)?$/u, '');
    else active.type = value;
  }
  close();
  return failed;
}

/**
 * One result row per planned file from its shard's output.
 * red: a case failed (named in `cases`); hung: its watchdog stopped it; no-result: the shard was red without running
 * its tests; unrun: the shard gave no answer, or was stopped before this file reported; green: it ran with no failing case. Node runs each file in its own process
 * and a collecting shard runs them all, so a red shard's file with no failing row passed.
 *
 * @param {object} shard
 * @param {string[]} shard.files - Planned files, repository-relative.
 * @param {string} shard.status - The shard attempt's status.
 * @param {string} shard.host
 * @param {string} shard.label
 * @param {string} shard.output - The attempt's merged log.
 * @param {Array<{ file: string, name: string, passed: boolean, skipped: boolean }>} shard.outcomes
 * @param {Record<string, number>} shard.times - Wall ms per file from the shard's own lines.
 * @param {string} sha
 * @returns {Array<{ file: string, status: string, cases: string[], secs: number|null, sha: string, shard: string, host: string }>}
 */
export function shardRows({ files, status, host, label, output, outcomes, times }, sha) {
  const failed = tapFailures(output, files);
  for (const row of outcomes) if (!row.passed) failed.set(row.file, [...new Set([...(failed.get(row.file) ?? []), row.name])]);
  // The watchdog names the file as a JSON string, absolute inside the shard's checkout.
  const stopped = [...String(output).matchAll(/run-tests: (?:HUNG|TIMEOUT) file ("(?:[^"\\]|\\.)*")/gu)].flatMap((match) => { try { return [JSON.parse(match[1])]; } catch { return []; } });
  const isHung = file => stopped.some(path => path === file || path.endsWith(`/${file}`));
  // A red shard that printed no TAP totals never ran its tests (a missing engine, a crash), so it vouches for no file.
  const ran = /^# tests \d+/mu.test(String(output)) || status === 'green';
  const cut = /^Landing gate stopped early|Landing shard .* stopped by the landing/mu.test(String(output));
  return files.map((file) => {
    const ms = times[file];
    const verdict = status !== 'green' && status !== 'red' ? 'unrun'
      : isHung(file) ? 'hung'
        : failed.has(file) ? 'red'
          : !ran ? 'no-result'
          : cut && !Number.isFinite(ms) ? 'unrun' : 'green';
    return { file, status: verdict, cases: failed.get(file) ?? [], secs: Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null, sha, shard: label, host };
  });
}
