/** A bare pullboard heartbeat is one sidecar write on the real CLI path: under 150 ms, no command registry, no recovery [C7,#3847]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import {
  fileFixtureItem,
  fixturePolicy,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** The seat's heartbeat rows in the private sidecar beside the board. */
function beats(box) {
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite.presence.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT seat, at FROM heartbeat').all(); } finally { db.close(); }
}

/** A project with a seat holding `count` claims, claimed in process. */
async function seatWithClaims(count) {
  const box = helpers.project('true');
  fixturePolicy(box, { claims: { releaseGone: false, releaseCooldownMinutes: 30, perSeat: Math.max(1, count) } });
  box.git(box.web, 'merge', '-q', 'main');
  const joined = joinFixtureSeat(box, box.web, 'web', { model: FIXTURE_MODEL });
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  const ids = [];
  for (let n = 0; n < count; n++) {
    const id = String(fileFixtureItem(box, box.repo, { lane: 'web', title: `Held ${n}`, check: 'true', args: ['--specs', 'G1'] }).item_id);
    const claimed = await box.runLocal(box.web, 'claim', id, '--no-next');
    assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
    ids.push(id);
  }
  return { box, ids };
}

test('clause 1: a bare heartbeat on the real CLI path takes under 150 ms best of five and imports no command registry or recovery [C7,#3847]', async () => {
  const { box } = await seatWithClaims(1);
  const times = [0, 1, 2, 3, 4].map(() => {
    const start = process.hrtime.bigint();
    const run = box.run(box.web, 'heartbeat');
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    return Number(process.hrtime.bigint() - start) / 1e6;
  }).sort((a, b) => a - b);
  assert.ok(times[0] < 150, `heartbeat took ${Math.round(times[0])} ms at best through bin/pullboard.js`); // budget: frozen bar, under 150 ms wall
  // A loader hook logs every file the entry loads: a bare heartbeat loads a handful, never the registry or recovery graphs.
  const log = join(privateFixtureFiles('pb-heartbeat-loads-').root, 'loads.txt');
  const hook = `import{appendFileSync}from"node:fs";export async function load(u,c,n){if(u.startsWith("file:"))appendFileSync(process.env.PB_LOADS,u+"\\n");return n(u,c)}`;
  const preload = `import{register}from'node:module';register('data:text/javascript,'+${JSON.stringify(encodeURIComponent(hook))});`;
  const entry = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  const run = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, entry, 'heartbeat'], { cwd: box.web, env: { ...box.env, PB_LOADS: log }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const loaded = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(loaded.length <= 12, `a bare heartbeat loaded ${loaded.length} modules: ${loaded.join(' ')}`);
  assert.ok(!loaded.some(url => /\/(?:commands|cli-main|recovery)\//u.test(url)), 'no command registry or recovery module loads');
});

test('clause 2: one call renews a seat with three claims, a seat with no claim still beats, and the claims stay held [C7,#3847]', async () => {
  const { box, ids } = await seatWithClaims(3);
  const run = box.run(box.web, 'heartbeat');
  assert.equal(run.code, 0, `${run.out}\n${run.err}`);
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite.presence.sqlite'));
  try {
    // Age the observation past the one-minute refresh window, then beat once more through the thin path.
    db.exec("UPDATE heartbeat SET at='2000-01-01T00:00:00.000Z'");
  } finally { db.close(); }
  const second = box.run(box.web, 'heartbeat');
  assert.equal(second.code, 0, `${second.out}\n${second.err}`);
  const after = beats(box);
  const mine = after.find(row => row.seat.endsWith(',"web-1"]'));
  assert.ok(mine && mine.at > '2020', 'the seat observation advanced past the aged value');
  const whoami = JSON.parse((await box.runLocal(box.web, 'heartbeat', '--json')).out);
  assert.equal(whoami.presence, 'live', 'the full path reads the thin path write as live presence');
  for (const id of ids) {
    const shown = await box.runLocal(box.web, 'show', id);
    assert.match(shown.out, /claimed/u, `claim #${id} stays held`);
  }
});

test('clause 2: a directory with no seat falls through to the full path and a lapsed claim is refused as before [C7,#3847]', async () => {
  const { box, ids } = await seatWithClaims(1);
  const released = await box.runLocal(box.web, 'release', ids[0], '--reason', 'BLOCKED', '--note', 'fixture lapse', '--no-next');
  assert.equal(released.code, 0, `${released.out}\n${released.err}`);
  const lapsed = await box.runLocal(box.web, 'submit', ids[0], '--no-next');
  assert.notEqual(lapsed.code, 0, 'a released claim is still refused at submit after a heartbeat');
  const unseated = await box.runLocal(box.repo, 'heartbeat', '--json');
  assert.equal(unseated.code, 0, `${unseated.out}\n${unseated.err}`);
});
