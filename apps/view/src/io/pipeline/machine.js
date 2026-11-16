/**
 * This machine's side of the Pipeline page (#6869): CPU by the part of the process each program belongs to, sampled
 * each time the open page asks (about every ten seconds), plus the gate workers, queues and runner slots the machine holds. Nothing here
 * reads the board; the page asks once a refresh and draws what the samples say, and a number this machine cannot read is null.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { availableParallelism } from 'node:os';
import { loadavg } from 'node:os';

const MIN_GAP_MS = 5000, NOW_MS = 5 * 60_000, KEEP_MS = 12 * 3_600_000, MINUTE_MS = 60_000;

/**
 * Name the part of the pipeline a process belongs to, from its command line: the person tunes by part
 * (gate workers, runners, landing, tests, agents), not by process id.
 *
 * @param {string} command
 * @returns {string}
 */
export function partOf(command) {
  const c = String(command);
  if (/fseventsd|\/mds(_stores)?\b|mdworker|Spotlight/.test(c)) return 'macOS file indexing';
  if (/submit-handoff-worker|handoff-worker-dispatcher/.test(c)) return 'gate hand-off workers';
  if (/runner-controller/.test(c)) return 'runner controllers';
  if (/automatic-landing|landing-worker|bin\/landing/.test(c)) return 'landing';
  if (/usage-checkpoint-worker/.test(c)) return 'usage checkpoint workers';
  if (/Google Chrome|Chromium|chrome-headless|--remote-debugging-port/.test(c)) return 'browser tests (Chrome)';
  if (/pullboard\.js\s+view\b/.test(c)) return 'board views';
  const cli = c.match(/pullboard\.js\s+(\S+)/);
  if (cli && /^\w+:/.test(cli[1])) return 'pullboard tooling run (commit snapshot)';
  if (cli) return cli[1] === 'next' ? 'pullboard next' + (/--wait/.test(c) ? ' (waiting)' : '') : 'pullboard ' + cli[1];
  if (/\bgit\b|git-remote|git-upload|cat-file/.test(c) && !/node/.test(c)) return 'git';
  if (/\bcodex\b/i.test(c)) return 'Codex agents';
  if (/Claude\.app|claude-code|\/claude\b|Claude Helper/.test(c)) return 'Claude app and agents';
  if (/WindowServer|kernel_task|launchd|logd|opendirectoryd|trustd|syspolicyd|XprotectService/.test(c)) return 'macOS system';
  if (/\bnode\b/.test(c)) return 'other node';
  if (/\bssh\b/.test(c)) return 'ssh to runners';
  return 'other';
}

/**
 * Average CPU per part over several samples, in cores (1.00 is one full core), with the busiest command of each part.
 *
 * @param {{ part: string, cpu: number, command: string }[][]} samples
 * @returns {{ part: string, cores: number, procs: number, command: string }[]}
 */
export function aggregateParts(samples) {
  const parts = new Map();
  for (const rows of samples) for (const row of rows) {
    const entry = parts.get(row.part) ?? { part: row.part, cpu: 0, procs: 0, top: new Map() };
    entry.cpu += row.cpu; entry.procs++;
    const key = row.command.slice(0, 120);
    entry.top.set(key, (entry.top.get(key) ?? 0) + row.cpu);
    parts.set(row.part, entry);
  }
  const n = Math.max(1, samples.length);
  return [...parts.values()].map(entry => ({ part: entry.part, cores: entry.cpu / n / 100, procs: entry.procs / n,
    command: [...entry.top].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '' })).sort((a, b) => b.cores - a.cores);
}

/** Run ps and read its rows; a failed run is null, so the machine shows no sample instead of a wrong one. */
function psRows(columns) {
  return new Promise(resolve => {
    execFile('ps', ['-axo', columns], { encoding: 'utf8', maxBuffer: 32 << 20, timeout: 8000 }, (error, stdout) => resolve(error ? null : stdout.split('\n')));
  });
}

/** Take one CPU sample: every process using any CPU, grouped by part. */
async function sample() {
  const lines = await psRows('%cpu=,command=');
  if (!lines) return null;
  const rows = [];
  for (const line of lines) {
    const match = line.match(/^\s*([\d.]+)\s+(.*)$/);
    if (!match) continue;
    const cpu = Number(match[1]);
    if (cpu > 0) rows.push({ part: partOf(match[2]), cpu, command: match[2] });
  }
  return rows;
}

/**
 * The CPU sampler: a sample is taken when the page asks (about every ten seconds while it is open, never more often than
 * every five), the last five minutes of them say what is running now, and each minute's mean is kept for twelve hours.
 * Nothing runs between reads, so the history covers the time the page was open.
 *
 * @returns {{ read: (at?: number) => object, take: (at?: number) => Promise<void>, add: (rows: object[], at: number) => void }}
 */
export function cpuSampler({ gap = MIN_GAP_MS } = {}) {
  const samples = [], minutes = new Map();
  let lastAt = 0;
  /** Record one sample's rows at an instant, and fold them into its minute. */
  const add = (rows, at) => {
    samples.push({ at, rows });
    while (samples.length && samples[0].at < at - NOW_MS) samples.shift();
    const key = Math.floor(at / MINUTE_MS);
    const entry = minutes.get(key) ?? minutes.set(key, []).get(key);
    entry.push(rows);
    for (const old of minutes.keys()) if (old * MINUTE_MS < at - KEEP_MS) minutes.delete(old);
    lastAt = at;
  };
  return {
    add,
    /** Take a sample unless one was taken a moment ago; a failed one leaves a gap. */
    async take(at = Date.now()) {
      if (at - lastAt < gap) return;
      lastAt = at;
      try { const rows = await sample(); if (rows) add(rows, at); } catch { /* A failed sample leaves a gap and never stops the page. */ }
    },
    read(at = Date.now()) {
      const recent = samples.filter(entry => entry.at >= at - NOW_MS).map(entry => entry.rows), now = aggregateParts(recent);
      const series = [...minutes.values()].map(group => new Map(aggregateParts(group).map(entry => [entry.part, entry.cores])));
      const names = new Set([...now.map(entry => entry.part), ...series.flatMap(entry => [...entry.keys()])]);
      const parts = [...names].map(part => {
        const current = now.find(entry => entry.part === part);
        const values = series.map(entry => entry.get(part) ?? 0);
        return { part, now: current?.cores ?? 0, procs: current ? Math.round(current.procs) : null, command: current?.command ?? '',
          avg: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, peak: values.length ? Math.max(...values) : null };
      }).filter(part => part.now > 0 || part.peak > 0).sort((a, b) => b.now - a.now || (b.avg ?? 0) - (a.avg ?? 0)).slice(0, 14);
      return { samples: recent.length, minutes: minutes.size, parts };
    },
  };
}

const sampler = cpuSampler();
let viewsRead = { at: 0, value: [] };

/** The running board views and when each started, read at most every fifteen seconds; a view started before main's head runs older code. */
async function boardViews(now) {
  if (now - viewsRead.at < 15_000) return viewsRead.value;
  const lines = await psRows('pid=,lstart=,command=');
  const value = [];
  for (const line of lines ?? []) {
    const match = line.trim().match(/^(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/);
    if (match && /pullboard\.js\s+view\b/.test(match[3])) value.push({ pid: Number(match[1]), startedMs: Date.parse(match[2]) });
  }
  viewsRead = { at: now, value: lines ? value : viewsRead.value };
  return viewsRead.value;
}

/**
 * Gate workers, gates waiting and runner slots from the machine's lease records.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The machine's resources database, open for reading.
 * @returns {{ gateWorkers: number, gateQueued: number, runnerSlots: number, runnerUsed: number }}
 */
export function readLeases(db) {
  const held = new Map(db.prepare('SELECT name, COUNT(*) AS n FROM holder GROUP BY name').all().map(row => [row.name, row.n]));
  const waiting = new Map(db.prepare('SELECT name, COUNT(*) AS n FROM waiter GROUP BY name').all().map(row => [row.name, row.n]));
  const runners = db.prepare("SELECT name, capacity FROM resource WHERE name LIKE 'runner:%'").all().filter(row => row.capacity > 0);
  return { gateWorkers: held.get('submit-handoff-workers') ?? 0, gateQueued: waiting.get('gate') ?? 0, runnerSlots: runners.reduce((sum, row) => sum + row.capacity, 0),
    runnerUsed: runners.reduce((sum, row) => sum + Math.min(held.get(row.name) ?? 0, row.capacity), 0) };
}

/** How many hand-offs wait: the numbered ticket files in the queue folder; its other files are bookkeeping. */
export function queuedTickets(names) { return names.filter(name => /^\d+-.+\.(json|reserved)$/u.test(name)).length; }

/** The lease counts from a file; null where the machine has no readable record. */
function leases(resourcesFile) {
  let db;
  try { db = new DatabaseSync(resourcesFile, { readOnly: true }); return readLeases(db); }
  catch { return { gateWorkers: null, gateQueued: null, runnerSlots: null, runnerUsed: null }; }
  finally { try { db?.close(); } catch { /* Already closed. */ } }
}

/**
 * Everything the page's This machine section and Main strip need from this machine, now.
 *
 * @param {{ resourcesFile: string, queueDirectory: string, repoRoot: string, now?: number }} where
 * @returns {Promise<object>}
 */
export async function machineRead({ resourcesFile, queueDirectory, repoRoot, now = Date.now() }) {
  await sampler.take(now);
  let diskFreeGb = null, handoffQueued = null;
  try { const stat = await statfs(repoRoot); diskFreeGb = Math.round(stat.bavail * stat.bsize / 1e8) / 10; } catch { /* Unreadable: the page shows a dash. */ }
  try { handoffQueued = queuedTickets(await readdir(queueDirectory)); } catch (error) { handoffQueued = error.code === 'ENOENT' ? 0 : null; }
  return { at: now, cores: availableParallelism(), load: loadavg(), diskFreeGb, handoffQueued, ...leases(resourcesFile), views: await boardViews(now), ...sampler.read(now) };
}
