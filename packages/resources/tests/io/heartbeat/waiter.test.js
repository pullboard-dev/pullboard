import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { takeResource } from '../../../index.js';

/** Use an actual repository pool; only this fixture's heartbeat timestamps are controlled. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-stale-waiter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const take = options => takeResource({ name: 'repo-pin-fixture', capacity: 1, scope: 'repo', root, ...options });
  return { take, file: join(root, '.git', 'pullboard', 'resources.sqlite') };
}

/** Pause a genuine live waiter between admission passes without retaining a SQLite writer. */
async function waiting(box, agent) {
  let entered;
  let resume;
  const ready = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { resume = resolve; });
  const stopped = new Error('private waiter stopped');
  const result = box.take({ agent, onWait: async () => {
    entered();
    await barrier;
    throw stopped;
  } }).then(lease => ({ lease }), error => ({ error }));
  await ready;
  return { stop: async () => {
    resume();
    const ended = await result;
    ended.lease?.release();
    assert.equal(ended.error, stopped);
  } };
}

/** Read or age only the disposable pool, never the machine's live resource database. */
function inPool(box, action) {
  const db = new DatabaseSync(box.file);
  try { return action(db); } finally { db.close(); }
}

test('a live gate waiter older than two minutes cannot block a free slot [C7]', async t => {
  const box = fixture(t);
  const holder = await box.take({ agent: 'holder' });
  const stale = await waiting(box, 'stale-head');
  let fresh;
  try {
    inPool(box, db => db.prepare('UPDATE waiter SET heartbeat = ? WHERE agent = ?')
      .run(Date.now() - 120_001, 'stale-head'));
    holder.release();
    fresh = await box.take({ agent: 'fresh', onWait: () => {
      assert.fail('free slot must admit the fresh waiter in its first admission pass');
    } });
    inPool(box, db => {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM waiter WHERE agent = ?').get('stale-head').n, 0);
      assert.equal(db.prepare('SELECT agent FROM holder').get().agent, 'fresh');
    });
  } finally { fresh?.release(); holder.release(); await stale.stop(); }
});

test('a live gate waiter below two minutes retains priority past the ordinary lease cutoff [C7]', async t => {
  const box = fixture(t);
  const holder = await box.take({ agent: 'holder' });
  const live = await waiting(box, 'live-head');
  try {
    inPool(box, db => db.prepare('UPDATE waiter SET heartbeat = ? WHERE agent = ?')
      .run(Date.now() - 60_000, 'live-head'));
    holder.release();
    const blocked = new Error('fresh waiter is behind a live head');
    await assert.rejects(box.take({ agent: 'fresh', onWait: () => { throw blocked; } }), error => error === blocked);
    inPool(box, db => assert.equal(db.prepare('SELECT agent FROM waiter').get().agent, 'live-head'));
  } finally { holder.release(); await live.stop(); }
});

test('a resumed gate cannot resurrect a removed arrival or release-order ticket [C7]', async t => {
  const box = fixture(t);
  const holder = await box.take({ agent: 'holder' });
  const old = await waiting(box, 'old-head');
  const saved = inPool(box, db => db.prepare('SELECT token, ticket, since FROM waiter WHERE agent = ?').get('old-head'));
  await old.stop();
  const fresh = await waiting(box, 'fresh-head');
  const observed = new Error('inspect resumed queue position');
  try {
    await assert.rejects(box.take({ agent: 'resumed', _resume: {
      token: saved.token, ticket: saved.ticket, queueTicket: saved.ticket, queuedAt: saved.since,
    }, onWait: state => {
      inPool(box, db => {
        const resumed = db.prepare('SELECT ticket, queue_ticket FROM waiter WHERE agent = ?').get('resumed');
        const head = db.prepare('SELECT ticket FROM waiter WHERE agent = ?').get('fresh-head');
        assert.ok(resumed.ticket > head.ticket, 'a missing old ticket rejoins behind the live waiter');
        assert.equal(resumed.queue_ticket, null, 'expired release-order priority cannot return');
      });
      assert.equal(state.position, 2);
      throw observed;
    } }), error => error === observed);
  } finally { await fresh.stop(); holder.release(); }
});

test('a stuck non-gate pin line clears: stale head is swept, a fresh waiter is admitted, and the swept owner rejoins at the back [C7]', async t => {
  const box = fixture(t);
  const holder = await box.take({ agent: 'holder' });
  const orphan = await waiting(box, 'orphan');
  let fresh;
  try {
    inPool(box, db => db.prepare('UPDATE waiter SET heartbeat = ? WHERE agent = ?').run(Date.now() - 20 * 60_000, 'orphan'));
    holder.release();
    fresh = await box.take({ agent: 'fresh', onWait: () => assert.fail('stale orphan must not block the line') });
    inPool(box, db => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM waiter WHERE agent = ?').get('orphan').n, 0));
    const rejoin = await waiting(box, 'orphan');
    inPool(box, db => assert.deepEqual(db.prepare('SELECT agent FROM waiter ORDER BY ticket').all().map(r => r.agent), ['orphan']));
    await rejoin.stop();
  } finally { fresh?.release(); holder.release(); await orphan.stop(); }
});
