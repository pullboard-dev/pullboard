/** Importing the runners package captures no tooling; the first dispatch does, so board commands stay fast [C7,#3070]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { copyPackageFiles } from '../packages/runners/index.js';
import { toolSourcePath } from '../packages/runners/index.js';

const helpers = createE2eHelpers();
test.after(helpers.cleanup);
const INDEX = fileURLToPath(new URL('../packages/runners/index.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVENTS = 230_000;

// Records every synchronous file read and child spawn, so the probe sees what import alone did.
const PROBE = `
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const seen = { reads: [], spawns: [] };
globalThis.__seen = seen;
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) { seen.reads.push(String(file)); return readFileSync.call(this, file, ...rest); };
for (const name of ['spawn', 'spawnSync', 'execFileSync', 'execFile', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = function (...args) { seen.spawns.push(JSON.stringify(args.slice(0, 2))); return original.apply(this, args); };
}
syncBuiltinESMExports();
const runners = await import(process.argv[2]);
const atImport = { reads: [...seen.reads], spawns: [...seen.spawns] };
runners.pinRunnerTooling();
runners.loadedToolingFiles({ rescan: false });
console.log(JSON.stringify({ atImport, afterUse: seen }));
`;

/** Is this a closure entry only a tooling capture reads? The parser pins its own two files at load by design. */
const toolingFile = file => /(?:bin\/runner-controller\.js|src\/runner-worker\.js)$/u.test(file);

test('clause 1: importing packages/runners parses no source and captures no tooling until first use [C7,#3070]', t => {
  const dir = helpers.sandbox().dir;
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, PROBE);
  const result = runFixtureChild(process.execPath, [probe, INDEX], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { atImport, afterUse } = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(atImport.reads.filter(toolingFile), [], 'import read tooling closure files');
  assert.deepEqual(atImport.spawns, [], 'import spawned a parser or other child');
  assert.ok(afterUse.reads.some(toolingFile), 'the first use captured the tooling closure');
  assert.ok(afterUse.spawns.some(args => args.includes('compiler-worker.mjs')), 'the first use parsed the closure');
});

// Loads an installed copy, edits one closure file after load, then makes the first use of the tooling.
const STALE = `
import { appendFileSync } from 'node:fs';
const runners = await import(process.argv[2]);
await new Promise(done => setTimeout(done, 20));
appendFileSync(process.argv[3], '\\n// changed after this controller loaded\\n');
try { runners.pinRunnerTooling(); runners.loadedToolingFiles({ rescan: false }); console.log('ACCEPTED'); }
catch (error) { console.log(error.code); }
`;

test('a closure file written after import, before first use, still refuses as changed tooling [C7,#3070]', () => {
  const dir = helpers.sandbox().dir;
  const installed = join(dir, 'installed');
  copyPackageFiles(ROOT, installed);
  const probe = join(dir, 'stale.mjs');
  writeFileSync(probe, STALE);
  const index = join(installed, 'packages/runners/index.js');
  const result = runFixtureChild(process.execPath, [probe, index, toolSourcePath(installed, 'src/runner-worker.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'RUNNER_TOOLING_CHANGED');
});

/** The best wall time of three `whoami` runs, so one scheduling stall on a loaded host is not read as a slow command. */
function bestWhoami(box) {
  assert.equal(box.run(box.web, 'whoami').code, 0);
  const times = [];
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    const result = box.run(box.web, 'whoami');
    times.push(performance.now() - started);
    assert.equal(result.code, 0, result.err);
  }
  return { best: Math.min(...times), times };
}

test('pullboard whoami on a 230,000-event board runs in under 300 ms [C7,#3070]', () => {
  const box = helpers.project();
  // The same command on the same host before the history exists: load on the host lifts both, the event count lifts only the second.
  const baseline = bestWhoami(box).best;
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const db = new DatabaseSync(file);
  try {
    // @pullboard-board-file fixture: a bulk copy of the board's own latest event builds a real-scale history fast
    const columns = db.prepare('PRAGMA table_info(event)').all().map(column => column.name).filter(name => name !== 'event_id');
    const list = columns.map(name => `"${name}"`).join(', ');
    const template = db.prepare('SELECT event_id FROM event ORDER BY event_id DESC LIMIT 1').get().event_id;
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${EVENTS})
      INSERT INTO event (${list}) SELECT ${list} FROM event, n WHERE event.event_id = ${template}`);
    assert.ok(db.prepare('SELECT count(*) AS n FROM event').get().n >= EVENTS);
  } finally { db.close(); }
  const { best, times } = bestWhoami(box);
  const limit = Math.max(300, baseline + 150);
  assert.ok(best < limit, `whoami took ${Math.round(best)} ms against ${Math.round(baseline)} ms on an empty board (runs ${times.map(Math.round).join(', ')}); limit ${Math.round(limit)} ms`);
});
