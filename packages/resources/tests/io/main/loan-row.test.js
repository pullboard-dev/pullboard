/** A per-file test loan's resource row leaves the machine store when its loan ends [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { listResources } from '../../../src/io/main.js';
import { takeResource } from '../../../src/io/main.js';

const TEMP = [];
after(() => { for (const path of TEMP) rmSync(path, { recursive: true, force: true }); });

/** Run one operation against a private machine home, restoring the caller's environment afterwards. */
function at(home, action) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { return action(); } finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

/** The resource names stored in one private machine pool, read straight from its table. */
function names(home) {
  const db = new DatabaseSync(join(home, 'resources.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT name FROM resource ORDER BY name').all().map(row => row.name); } finally { db.close(); }
}

test('resources.loan-row.a-test-file-loan-row-is: a test-file-loan row is removed when its loan is released [C7]', async () => {
  const home = privateFixtureFiles('pullboard-loan-row-').root;
  TEMP.push(home);
  const name = 'test-file-loan:07b1b324-a999-40a2-9581-8be1b30256f3';
  const lease = await at(home, () => takeResource({ name, capacity: 1, scope: 'machine', agent: 'loan-release' }));
  assert.ok(names(home).includes(name), 'a live loan has its resource row');
  lease.release();
  assert.ok(!names(home).includes(name), 'releasing the loan removes its row');
});

test('resources.loan-row.an-expired-or-leftover-test-file: an expired or leftover test-file-loan row is swept by the next read and other rows stay [C7]', async () => {
  const home = privateFixtureFiles('pullboard-loan-sweep-').root;
  TEMP.push(home);
  const keep = await at(home, () => takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'loan-keeper' }));
  try {
    const db = new DatabaseSync(join(home, 'resources.sqlite'));
    try { db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?)').run('test-file-loan:ab0cdb19-e12c-4cd9-8614-82098ef30c56', 1); } finally { db.close(); }
    at(home, () => listResources());
    assert.deepEqual(names(home).filter(entry => entry.startsWith('test-file-loan:')), [], 'a loan with no holder leaves the store');
    assert.ok(names(home).includes('gate'), 'a live non-loan resource keeps its row');
  } finally { keep.release(); }
});
