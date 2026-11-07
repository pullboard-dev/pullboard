import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { healLeakedRunner } from '../packages/resources/src/shell/runner-leak-heal.js';
import { stopScript } from '../packages/runners/src/shell/runner-leak-stop.js';
import { privateFixtureFiles } from './fixture-child.js';

const HOST = 'coreyolson@192.168.1.51';
const row = { host: HOST, since: '2026-11-06T01:16:00.000Z', detail: 'TRANSPORT_UNVERIFIED' };
const unhealthy = { healthy: false, step: 'worker readiness', reason: 'transport lost' };

/** A resource queue with one quarantined runner and the given live holders on it. */
function queueWith(holders) {
  const home = privateFixtureFiles('pullboard-leak-live-').root;
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  db.exec(`CREATE TABLE runner_unavailable (host TEXT, since TEXT, detail TEXT, probe_token TEXT, probe_until INTEGER, healing INTEGER);
    CREATE TABLE holder (token TEXT, name TEXT, runner TEXT, item TEXT, pid INTEGER);
    CREATE TABLE runner_recovery_event (id TEXT, host TEXT, at TEXT, kind TEXT, detail TEXT)`);
  db.prepare('INSERT INTO runner_unavailable VALUES (?, ?, ?, ?, 0, 0)').run(HOST, row.since, row.detail, 'token-1');
  for (const id of holders) db.prepare('INSERT INTO holder VALUES (?, ?, ?, ?, ?)').run('tok-' + id, 'gate', HOST, id, 1);
  return { db, home };
}

test('clause 1: a quarantine heal on a runner with a holder never calls the leak stop and records the runner was busy [C7]', async () => {
  const { db, home } = queueWith(['live-1']);
  try {
    const proof = await healLeakedRunner(db, row, { host: HOST }, unhealthy,
      { leakProbe: async () => { throw new Error('leak probe must not run on a busy runner'); }, idleProbe: async () => unhealthy, token: 'token-1' });
    assert.equal(proof, unhealthy);
    const event = db.prepare('SELECT kind, detail FROM runner_recovery_event').get();
    assert.equal(event.kind, 'leak-stop-skipped');
    assert.match(JSON.parse(event.detail).reason, /busy/u);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('clause 2: the stop script excludes a live job id and a fake ps listing keeps only the non-live job pid [C7]', () => {
  const dir = privateFixtureFiles('pullboard-leak-ps-').root;
  try {
    const root = join(dir, 'runner');
    const script = stopScript(root, ['live-job']);
    assert.match(script, /live-job/u);
    assert.match(script, /index\(\$0,ENVIRON\["J"\] ids\[i\]\)/u);
    writeFileSync(join(dir, 'ps'), `#!/bin/sh
case "$*" in
  *-axo*) printf '%s\\n' '111 Mon Nov 6 10:00:00 2026 node ${root}/jobs/live-job/step' '222 Mon Nov 6 10:00:00 2026 node ${root}/jobs/dead-job/step' '333 Mon Nov 6 10:00:00 2026 node /elsewhere' ;;
esac
`);
    chmodSync(join(dir, 'ps'), 0o755);
    const run = spawnSync('sh', ['-c', script.replace(/^sh -c /u, 'sh -c ')], { env: { ...process.env, PATH: dir + ':' + process.env.PATH }, encoding: 'utf8' });
    assert.equal(run.stdout.trim(), '222', run.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
