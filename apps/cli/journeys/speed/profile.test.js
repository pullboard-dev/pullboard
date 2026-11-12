/**
 * Every local board command answers under its 200 ms budget on a large board, and a command over it fails the case [C7].
 * The commands run as the real CLI, through the resident board process, on a board seeded with about 2,500 items and
 * 58,000 shouts, three times each; a preloaded recorder logs any network use by the client, the resident process or
 * anything they start.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { largeBoard } from '../../tests/fixtures/board/large.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { PULLBOARD_ENTRY } from '../../src/io/resident/client.js';
import { residentPoolSize } from '../../src/io/resident/client.js';
import { residentSocket } from '../../src/io/resident/client.js';

const BUDGET_MS = 200;
const RUNS = 3;

/** The middle of the samples. */
function median(samples) {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

/** The failure for a command whose median is over the budget, naming the command, its time and the budget; null within it. */
function overBudget(name, samples, budget = BUDGET_MS) {
  const time = median(samples);
  return time < budget ? null : `${name} took ${time.toFixed(0)} ms (median of ${samples.map(ms => ms.toFixed(0)).join(', ')}), over its ${budget} ms budget`;
}

/** Fail with every command over the budget. */
function assertWithinBudget(measured) {
  const slow = measured.map(([name, samples]) => overBudget(name, samples)).filter(Boolean);
  assert.deepEqual(slow, [], slow.join('\n'));
}

/**
 * Time `RUNS` calls of one command. `call(run)` runs it once and returns its result; `before(run)` prepares each call
 * untimed. A result whose code is not in `ok` fails, so a refused command never counts as a fast one.
 */
function measure(name, call, { before = () => {}, ok = [0] } = {}) {
  const samples = [];
  for (let run = 0; run < RUNS; run += 1) {
    before(run);
    const started = performance.now();
    const result = call(run);
    samples.push(performance.now() - started);
    assert.ok(ok.includes(result.code), `${name} exited ${result.code}: ${result.err}${result.out}`);
  }
  console.log(`# ${name} median ${median(samples).toFixed(0)} ms (${samples.map(ms => ms.toFixed(0)).join(', ')})`);
  return [name, samples];
}

/**
 * Write a preload that records every network attempt (a TCP connect, a name lookup, a fetch) to `log`, and each
 * process that loaded it to `loads`. A local socket path, how a client reaches the resident board process, is not
 * the network.
 */
function networkRecorder(dir) {
  const file = join(dir, 'network-recorder.mjs');
  const log = join(dir, 'network.log');
  const loads = join(dir, 'network-loads.log');
  writeFileSync(file, `import net from 'node:net';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
const record = (what) => appendFileSync(${JSON.stringify(log)}, process.pid + ' ' + what + '\\n');
appendFileSync(${JSON.stringify(loads)}, process.pid + ' ' + process.argv.slice(1).join(' ') + '\\n');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' && first !== null ? first : typeof first === 'string' ? { path: first } : { port: first, host: args[1] };
  if (!options.path) record('connect ' + (options.host ?? 'localhost') + ':' + options.port);
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) { record('dns ' + host); return lookup.call(this, host, ...rest); };
const promisesLookup = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) { record('dns ' + host); return promisesLookup.call(this, host, ...rest); };
const realFetch = globalThis.fetch;
import cp from 'node:child_process';
const spawnLog = ${JSON.stringify(join(dir,'spawns.log'))};
for (const name of ['spawnSync','execFileSync','execSync','spawn','execFile','exec']) {
  const real = cp[name];
  cp[name] = function (...a) { const t = performance.now(); const r = real.apply(this, a); appendFileSync(spawnLog, process.pid + ' ' + name + ' ' + (typeof a[0]==='string'? a[0] : '') + ' ' + (Array.isArray(a[1])? a[1].join(' ').slice(0,90):'') + ' ' + (performance.now()-t).toFixed(1) + '\\n'); return r; };
}
const realFetch0 = 1;
globalThis.fetch = function (url, ...rest) { record('fetch ' + url); return realFetch.call(this, url, ...rest); };
`);
  writeFileSync(log, '');
  writeFileSync(loads, '');
  return { file, log, loads, spawns: join(dir,'spawns.log'), env: { NODE_OPTIONS: `--import=${pathToFileURL(file).href}` } };
}

/** Stop every resident board process this board started, so the sandbox can be removed. */
function stopResidents(repo) {
  for (let slot = 0; slot < residentPoolSize({}); slot += 1) {
    const place = residentSocket(repo, PULLBOARD_ENTRY, slot);
    if (!place) continue;
    try { process.kill(Number(readFileSync(place.pid, 'utf8').trim()), 'SIGKILL'); } catch { /* None started, or it already exited. */ }
  }
}

/** The JSON a setup command printed, requiring it to have worked. */
function json(result, what) {
  assert.equal(result.code, 0, `${what}: ${result.err}${result.out}`);
  return JSON.parse(result.out);
}

test('clauses 1 and 2: each local command answers under 200 ms on a large board, with no network [C7]', (t) => {
  const box = largeBoard(t);
  box.beforeCleanup(() => stopResidents(box.repo));
  const recorder = networkRecorder(box.dir);
  // The resident board process serves the board commands, as on a person's machine; test markers would turn it off.
  for (const name of ['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete box.env[name];
  Object.assign(box.env, recorder.env, { PULLBOARD_RESIDENT: '1' });

  // Undiagnosed items keep their strong route, so a coordinator may edit their briefs.
  const added = (title) => fileFixtureItem(box, box.repo, { lane: 'web', title, diagnose: false, args: ['--specs', 'G1'] }).item_id;
  const own = added('Speed claim');
  const held = added('Speed hold');
  const submits = [0, 1, 2].map(run => added(`Speed submit ${run}`));
  // The first command starts the resident process (and runs in-process); the second warms it. Neither is timed.
  json(box.run(box.web, 'status', '--json'), 'warm status');
  json(box.run(box.web, 'status', '--json'), 'warm status');
  writeFileSync(recorder.loads, '');

  const web = (...args) => () => box.run(box.web, ...args);
  const repo = (...args) => () => box.run(box.repo, ...args);
  const setup = (cwd, ...args) => json(box.run(cwd, ...args, '--json'), args.join(' '));
  const release = ['release', String(own), '--reason', 'OTHER', '--note', 'Speed budget sample.', '--no-next'];
  const dump = (name) => { try { console.log('# SPAWNS ' + name + '\n' + readFileSync(recorder.spawns, 'utf8')); } catch (e) { console.log('# nospawns ' + e.message); } writeFileSync(recorder.spawns, ''); };
  writeFileSync(recorder.spawns, '');
  const measured = [
    measure('claim', web('claim', String(own))),
  ];
  dump('claim');
  measured.push(measure('release', web(...release)));
  dump('release');
  // Next claims work for the seat; each run's claim is handed back untimed, so every run is a fresh claim.
  const nexts = [];
  measured.push(measure('next', (run) => {
    const result = box.run(box.web, 'next', '--build', '--json');
    if (result.code === 0) nexts[run] = JSON.parse(result.out);
    return result;
  }, { before: (run) => {
    const id = run && (nexts[run - 1]?.item?.item_id ?? nexts[run - 1]?.item_id);
    if (id) setup(box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'Speed budget sample.', '--no-next');
  } }));
  dump('next');
  const lastNext = nexts.at(-1)?.item?.item_id ?? nexts.at(-1)?.item_id;
  if (lastNext) setup(box.web, 'release', String(lastNext), '--reason', 'OTHER', '--note', 'Speed budget sample.', '--no-next');
  // Submit needs the seat's claim on an item and a clean commit; each run claims its own item and commits once, untimed.
  measured.push(measure('submit', (run) => box.run(box.web, 'submit', String(submits[run]), '--no-next'), { before: (run) => {
    // Each submit starts from main, so no run stacks on the previous run's unverified commit.
    runFixtureGit(['checkout', '-q', '-B', `web/speed-${run}`, 'main'], { cwd: box.web, env: box.env });
    setup(box.web, 'claim', String(submits[run]));
    mkdirSync(join(box.web, 'web'), { recursive: true });
    writeFileSync(join(box.web, 'web', `speed-${run}.js`), `export const speed = ${run};\n`);
    runFixtureGit(['add', '-A'], { cwd: box.web, env: box.env });
    runFixtureGit(['commit', '-q', '-m', `feat(web): speed budget ${run} [G1]`], { cwd: box.web, env: box.env });
  } }));

  dump('submit');
  const loads = readFileSync(recorder.loads, 'utf8').split('\n').filter(Boolean);
  assert.ok(loads.length >= measured.length * RUNS, `the recorder loaded in every timed command: ${loads.length} loads`);
  assert.equal(readFileSync(recorder.log, 'utf8'), '', 'no timed command, nor anything it started, touched the network');
  assert.fail('profile only');
});

test('clause 2: the network recorder logs a TCP connect and a name lookup, so its empty log means no network [C7]', (t) => {
  const box = largeBoard(t, { scale: { items: 0, events: 0, shouts: 0, seats: 0 } });
  const recorder = networkRecorder(box.dir);
  const probe = "import net from 'node:net'; import dns from 'node:dns';"
    + " dns.lookup('localhost', () => {}); net.connect(9, '127.0.0.1').on('error', () => {});";
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', probe],
    { cwd: box.dir, env: { ...box.env, ...recorder.env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  const log = readFileSync(recorder.log, 'utf8');
  assert.match(log, /connect 127\.0\.0\.1:9/u);
  assert.match(log, /dns localhost/u);
});

test('clause 3: a stand-in command that takes 300 ms fails, naming the command, its time and the 200 ms budget [C7]', () => {
  const standIn = () => runFixtureChild(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)'],
    { cwd: import.meta.dirname, encoding: 'utf8' });
  const measured = [measure('stand-in', () => ({ code: standIn().status, out: '', err: '' }))];
  assert.throws(() => assertWithinBudget(measured), /stand-in took (?:[3-9]\d\d|\d{4,}) ms \(median of [^)]*\), over its 200 ms budget/u);
});
