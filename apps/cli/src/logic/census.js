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

/** Most files one pulled census job runs, so its receipt's output tail and case outcomes still name every file. */
export const PULLED_FILES_PER_JOB = 40;

/**
 * Shards for a census on a pull board: the runners' count, or more so that no job runs over PULLED_FILES_PER_JOB files.
 *
 * @param {number} files
 * @param {number} runners - censusShardCount of the registered runners.
 * @returns {number}
 */
export function pulledShardCount(files, runners, perJob = PULLED_FILES_PER_JOB) {
  return Math.max(1, runners, Math.ceil(files / perJob));
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

/** The case-time line a pulled shard's log gets per file, so a clipped receipt tail still gives each file's case time. */
export const FILE_CASE_LINE = '# landing-file-case-ms ';

/**
 * Milliseconds each file spent inside its top-level test cases, read from TAP: every case at indent 0 carries a
 * `duration_ms`, and the case's name finds its file in the outcome rows (a name shared by several files is split evenly).
 * Why: the file's wall time minus this is its setup (imports, fixtures, git, child starts), the part U149 can cut [C7,#9028].
 *
 * @param {string} output
 * @param {Array<{ file: string, name: string }>} outcomes
 * @returns {Record<string, number>}
 */
export function tapCaseMs(output, outcomes) {
  const owners = new Map();
  for (const row of outcomes ?? []) owners.set(row.name, [...new Set([...(owners.get(row.name) ?? []), row.file])]);
  const out = {};
  const lines = String(output).split('\n');
  for (let at = 0; at < lines.length; at += 1) {
    const head = /^(?:not ok|ok)\s+\d+\s+-\s+(.*)$/u.exec(lines[at]);
    if (!head) continue;
    let ms = null;
    for (let next = at + 1; next < lines.length && /^\s/u.test(lines[next]); next += 1) {
      // Only this case's own block: stop at a nested case's line, whose duration is its own.
      if (/^\s+(?:not ok|ok)\s+\d+\s+-/u.test(lines[next])) break;
      const field = /^ {2}duration_ms:\s*([\d.]+)\s*$/u.exec(lines[next]);
      if (field) { ms = Number(field[1]); break; }
    }
    const files = owners.get(head[1].replace(/\s+#\s*(?:SKIP|TODO)\b.*$/iu, '')) ?? owners.get(head[1]);
    if (ms === null || !files?.length) continue;
    for (const file of files) out[file] = (out[file] ?? 0) + ms / files.length;
  }
  return out;
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
 * @returns {Array<{ file: string, status: string, cases: string[], secs: number|null, setupSecs: number|null, sha: string, shard: string, host: string }>}
 */
export function shardRows({ files, status, host, label, output, outcomes, times }, sha) {
  const failed = tapFailures(output, files);
  for (const row of outcomes) if (!row.passed) failed.set(row.file, [...new Set([...(failed.get(row.file) ?? []), row.name])]);
  // The watchdog names the file as a JSON string, absolute inside the shard's checkout.
  const stopped = [...String(output).matchAll(/run-tests: (?:HUNG|TIMEOUT) file ("(?:[^"\\]|\\.)*")/gu)].flatMap((match) => { try { return [JSON.parse(match[1])]; } catch { return []; } });
  const isHung = file => stopped.some(path => path === file || path.endsWith(`/${file}`));
  // In a red shard a file is green only on its own pass record; a file with no row of its own is no-result, never green.
  const passed = new Set(outcomes.filter(row => row.passed).map(row => row.file));
  // A red shard with neither TAP totals nor a pass record never ran its tests (a missing engine, a crash), so it vouches
  // for no file. A pass record proves the run too: a pulled receipt clips its log to fit, which can cut the totals line
  // while the outcomes keep every file's result, and 533 of 624 census rows read no-result that way [C7,#8293].
  const ran = /^# tests \d+/mu.test(String(output)) || status === 'green' || passed.size > 0;
  const cut = /^Landing gate stopped early|Landing shard .* stopped by the landing/mu.test(String(output));
  // Each file's own exit code, as its shard printed it: one cancelled case voids a shard's case outcomes, and 313 files
  // of the 15 Nov census read no-result that way though each file's process said whether it passed [C7,#8304].
  const exits = new Map();
  for (const [, code, path] of String(output).matchAll(/^# landing-file-exit (\d+) (.+)$/gmu)) {
    const key = path.replace(/^\.\//u, '');
    exits.set(key, Math.max(exits.get(key) ?? 0, Number(code)));
  }
  // Files overlap inside a shard, so their wall times can sum past the shard's own tests phase; scale them down to it so
  // overlap is never counted twice and the census total is real runner time [C7,#8890].
  const phase = [...String(output).matchAll(/^run-tests: phases .*?\btests (\d+(?:\.\d+)?)s/gmu)].at(-1);
  const total = files.reduce((sum, file) => sum + (Number.isFinite(times[file]) ? times[file] : 0), 0);
  const scale = phase && total > Number(phase[1]) * 1000 ? (Number(phase[1]) * 1000) / total : 1;
  // Case time per file: the runner's own record when the receipt tail was clipped, else the shard's TAP [C7,#9028].
  const caseMs = { ...tapCaseMs(output, outcomes) };
  for (const [, ms, path] of String(output).matchAll(/^# landing-file-case-ms (\d+(?:\.\d+)?) (.+)$/gmu)) caseMs[path.replace(/^\.\//u, '')] = Number(ms);
  return files.map((file) => {
    const ms = Number.isFinite(times[file]) ? times[file] * scale : times[file], exit = exits.get(file);
    const verdict = status !== 'green' && status !== 'red' ? 'unrun'
      : isHung(file) ? 'hung'
        : failed.has(file) || exit > 0 ? 'red'
          : exit === 0 ? 'green'
          : !ran || (status === 'red' && !passed.has(file)) ? 'no-result'
          : cut && !Number.isFinite(ms) ? 'unrun' : 'green';
    const cases = failed.get(file) ?? (exit > 0 ? [`its test process exited ${exit} with no failing case named`] : []);
    const wall = times[file], cased = caseMs[file];
    const setupSecs = Number.isFinite(wall) && Number.isFinite(cased) ? Math.round(Math.max(0, wall - cased) * scale / 100) / 10 : null;
    return { file, status: verdict, cases, setupSecs, secs: Number.isFinite(ms) ? (scale < 1 ? Math.floor(ms / 100) : Math.round(ms / 100)) / 10 : null, sha, shard: label, host };
  });
}

/**
 * The per-file time lines a pulled shard's log gets, from the runner's whole-output record, because the receipt's clipped
 * tail has lost the shard's own lines and 1115 of 1536 rows of the 15 Nov census had no secs [C7,#8576].
 *
 * @param {Record<string, number>|null|undefined} times - Wall ms per file.
 * @param {string} prefix - The time line's prefix (FILE_TIME_LINE).
 * @returns {string}
 */
export function pulledTimeLines(times, prefix) {
  return Object.entries(times ?? {}).map(([file, ms]) => `${prefix}${Math.round(ms)} ${file}\n`).join('');
}

/**
 * One outcome row per file from a pulled shard's per-file verdicts, for a shard whose framed case outcomes were dropped
 * (too long for the receipt line, or voided by a nested failure). Why: without rows a red shard's files read as
 * no-result together, though the runner saw each file's own result [C7,#7920].
 *
 * @param {Record<string, 'green' | string[]> | null | undefined} verdicts - File to 'green' or its first failing cases.
 * @returns {Array<{ file: string, name: string, passed: boolean, skipped: boolean }> | null}
 */
export function verdictOutcomes(verdicts) {
  if (!verdicts || typeof verdicts !== 'object') return null;
  const rows = [];
  for (const [file, verdict] of Object.entries(verdicts)) {
    if (verdict === 'green') rows.push({ file, name: 'every case in the file', passed: true, skipped: false });
    else if (Array.isArray(verdict)) for (const name of verdict) rows.push({ file, name: String(name), passed: false, skipped: false });
  }
  return rows.length ? rows : null;
}

/**
 * The per-file times a census measured, in the milliseconds the plan reads: one entry for every green or red row that
 * has secs. Why those rows only: an unrun, hung or no-result file has no time worth planning by [C7].
 *
 * @param {Iterable<{ file: string, status: string, secs: number|null }>} rows
 * @returns {Record<string, number>}
 */
/**
 * The row a census reports for a non-green file after its one rerun alone: the rerun's row, marked flaky when it was
 * green, with both outcomes kept. Why: 66 of 94 non-green files in census 4 were green on rerun (runner load), and the
 * separate pass 2 that found them took 26 minutes [C7,#9138].
 *
 * @param {{ status: string, cases: string[], shard: string, host: string }} first - The file's row from its job.
 * @param {{ status: string, cases: string[], shard: string, host: string }} again - The file's row from its rerun alone.
 * @returns {object}
 */
export function rerunRow(first, again) {
  const outcomes = [first, again].map(({ status, cases, shard, host }) => ({ status, cases, shard, host }));
  return { ...again, ...(again.status === 'green' ? { flaky: true } : {}), outcomes };
}

/** True for a census row worth one rerun alone: anything but green or skipped [C7,#9138]. */
export const rerunnable = row => row.status !== 'green' && row.status !== 'skipped';

/**
 * The two lists a census with reruns writes beside its rows, each sorted, one line per file: `reds` holds every row still
 * not green after its rerun and not hung, as the file, a tab and its first failing case (else its status); `slow` holds
 * every hung file. Why: the rows already carry each non-green file's rerun alone, so a separate pass 2 that rebuilt these
 * lists took 10-31 minutes of every census cycle [C7,#10348].
 *
 * @param {Iterable<{ file: string, status: string, cases?: string[] }>} rows - The census's final rows.
 * @returns {{ reds: string, slow: string }} Each list's text, empty when it has no line.
 */
export function censusVerdictLists(rows) {
  const reds = [], slow = [];
  for (const row of rows) {
    if (row.status === 'hung') slow.push(row.file);
    else if (rerunnable(row)) reds.push(`${row.file}\t${String(row.cases?.[0] ?? row.status).replace(/\s+/gu, ' ').slice(0, 160)}`);
  }
  const text = list => list.sort().map(line => `${line}\n`).join('');
  return { reds: text(reds), slow: text(slow) };
}

/**
 * Wall time of each shard of one census, from its rows: a shard's rows share a label and the job's start and end instants,
 * so the shard's time is the widest end minus start among them. Rows with no usable instants are skipped, so a census
 * written before the instants were recorded gives an empty list [C7,U151].
 *
 * @param {Array<{ shard?: string, startedAt?: string, endedAt?: string }>} rows
 * @returns {number[]} Milliseconds, one per shard that has a time.
 */
export function previousShardMs(rows) {
  const byShard = new Map();
  for (const { shard, startedAt, endedAt } of rows) {
    const ms = Date.parse(endedAt) - Date.parse(startedAt);
    if (typeof shard === 'string' && Number.isFinite(ms) && ms > 0) byShard.set(shard, Math.max(byShard.get(shard) ?? 0, ms));
  }
  return [...byShard.values()];
}

export function rowFileTimes(rows) {
  const measured = {};
  for (const { file, status, secs } of rows) if ((status === 'green' || status === 'red') && Number.isFinite(secs) && secs >= 0) measured[file] = Math.round(secs * 1000);
  return measured;
}

/**
 * Cut a census into `count` jobs of near-equal measured time, heaviest first. Each file, heaviest first, goes to the
 * lightest job so far, so the heaviest and lightest job differ by at most one file's time; a file with no time weighs the
 * known average, and with no times at all every file weighs one. The jobs come back heaviest first, so a runner that pulls
 * early takes the long ones and the short ones fill the end of the run [C7].
 *
 * @param {string[]} files - Distinct repository-relative test files.
 * @param {number} count - Most jobs to cut.
 * @param {Record<string, number>} [times] - Last measured wall ms by file.
 * @returns {{ files: string[], weight: number }[]}
 */
export function balancedJobs(files, count, times = {}) {
  const known = files.map(file => times[file]).filter(ms => Number.isFinite(ms) && ms >= 0);
  const average = known.length ? known.reduce((sum, ms) => sum + ms, 0) / known.length : 1;
  const weight = file => (known.length ? (Number.isFinite(times[file]) && times[file] >= 0 ? times[file] : average) : 1);
  const jobs = Array.from({ length: Math.max(1, Math.min(count, files.length)) }, () => ({ files: [], weight: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = jobs.reduce((best, job) => (job.weight < best.weight || (job.weight === best.weight && job.files.length < best.files.length) ? job : best));
    lightest.files.push(file);
    lightest.weight += weight(file);
  }
  for (const job of jobs) job.files.sort((a, b) => a.localeCompare(b));
  return jobs.filter(job => job.files.length).sort((a, b) => b.weight - a.weight || a.files[0].localeCompare(b.files[0]));
}

/**
 * Cut a census into jobs of at most `limitMs` measured time each (and PULLED_FILES_PER_JOB files), heaviest first. Files,
 * heaviest first, go into the first job they fit, so no job weighs over the larger of the limit and its slowest file, and
 * there are at least ceil(total / limit) jobs. A file with no time weighs the known average, and with no times at all one ms [C7].
 *
 * @param {string[]} files - Distinct repository-relative test files.
 * @param {Record<string, number>} times - Last measured wall ms by file.
 * @param {number} limitMs - Most measured ms one job holds.
 * @returns {{ files: string[], weight: number }[]}
 */
export function timeBoundJobs(files, times, limitMs) {
  const known = files.map(file => times[file]).filter(ms => Number.isFinite(ms) && ms >= 0);
  const average = known.length ? known.reduce((sum, ms) => sum + ms, 0) / known.length : 1;
  const weight = file => (Number.isFinite(times[file]) && times[file] >= 0 ? times[file] : average);
  const jobs = [];
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const fits = jobs.find(job => job.files.length < PULLED_FILES_PER_JOB && job.weight + weight(file) <= limitMs);
    const job = fits ?? jobs[jobs.push({ files: [], weight: 0 }) - 1];
    job.files.push(file);
    job.weight += weight(file);
  }
  for (const job of jobs) job.files.sort((a, b) => a.localeCompare(b));
  return jobs.sort((a, b) => b.weight - a.weight || a.files[0].localeCompare(b.files[0]));
}

/**
 * The file kill, in milliseconds, a pulled census job carries under census.fileKillSeconds: that many seconds when every
 * file in the job has a recorded time under it, else null (the job keeps the usual 600 s stop). Why: a file with a short
 * record that runs on was hung or stalled, and it need not hold its job to the hard stop [C7,#10350].
 *
 * @param {string[]} files - The job's files.
 * @param {Record<string, number>} times - Recorded ms per file.
 * @param {number|null} killSeconds - The census.fileKillSeconds setting.
 * @returns {number|null}
 */
export function shardFileKillMs(files, times, killSeconds) {
  if (!killSeconds || !files.length) return null;
  return files.every(file => Number.isFinite(times[file]) && times[file] < killSeconds * 1000) ? killSeconds * 1000 : null;
}

/**
 * The census plan: by measured time, heaviest job first, when `balanceByTime` is on; otherwise exactly what `base` (the
 * landing planner) cuts, so a machine that has not opted in plans as it always did [C7].
 *
 * @param {string[]} files
 * @param {number} count
 * @param {Record<string, number>} times
 * @param {boolean} balanceByTime - The census.balanceByTime setting.
 * @param {(files?: string[]) => { files: string[], weight: number }[]} base - The landing planner, already bound to these files, count and times; given the files left after solo ones are cut out.
 * @param {number|null} [jobMinutes] - The census.jobMinutes setting; when set it decides the plan, and `count` is ignored.
 * @param {number|null} [soloSeconds] - The census.soloFileSeconds setting; when set, each file recorded slower than this is a one-file job and the rest plan as above (why: a slow file inside a mixed job set the census's end).
 * @returns {{ files: string[], weight: number }[]}
 */
export function censusPlan(files, count, times, balanceByTime, base, jobMinutes = null, soloSeconds = null) {
  const solo = soloSeconds ? files.filter(file => Number.isFinite(times[file]) && times[file] > soloSeconds * 1000) : [];
  const rest = solo.length ? files.filter(file => !solo.includes(file)) : files;
  const alone = [...solo].sort((a, b) => times[b] - times[a] || a.localeCompare(b)).map(file => ({ files: [file], weight: times[file] }));
  let jobs;
  if (!rest.length) jobs = [];
  else if (jobMinutes) jobs = timeBoundJobs(rest, times, jobMinutes * 60_000);
  else jobs = balanceByTime ? balancedJobs(rest, count, times) : base(rest);
  return solo.length ? [...alone, ...jobs].sort((a, b) => b.weight - a.weight || a.files[0].localeCompare(b.files[0])) : jobs;
}
