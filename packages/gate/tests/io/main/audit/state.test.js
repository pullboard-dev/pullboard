/** Runner fixture waits follow their actual deadline and retain useful state [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readRemoteGateHolders } from '../../../fixtures/runner/holders.js';
import { waitForCondition } from '../../../fixtures/runner/holders.js';
import { runFixtureChildAsync } from '../../../fixtures/child.js';

test('a runner fixture wait observes a real holder release within its fixture deadline [C7]', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-fixture-wait-'));
  const file = join(dir, 'resources.sqlite');
  const db = new DatabaseSync(file);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec("CREATE TABLE holder (name TEXT, token TEXT, pid INTEGER, agent TEXT, browser INTEGER, item TEXT, kind TEXT); INSERT INTO holder VALUES ('gate','fixture-only',42,'owned-fixture',0,'wait','fixture')");
  const controller = new AbortController();
  t.after(() => controller.abort());
  const release = setTimeout(() => db.exec('DELETE FROM holder'), 40); // budget: a controlled real SQLite release handshake, not a throughput limit.
  t.after(() => clearTimeout(release));
  await waitForCondition(() => readRemoteGateHolders(file).length === 0, 'owned holder release', { signal: controller.signal });
  assert.deepEqual(readRemoteGateHolders(file), []);
});

test('a runner fixture timeout names elapsed time and last state at its real test deadline [C7]', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-fixture-deadline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'held.test.mjs');
  const module = pathToFileURL(join(import.meta.dirname, '../../../fixtures/runner/holders.js')).href;
  writeFileSync(file, `import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { waitForCondition } from ${JSON.stringify(module)};
test('held state reaches its actual fixture deadline [C7]', { timeout: 80 }, async t => { // budget: deliberate test-owned abort; the wait must report it without a private deadline.
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE holder (pid INTEGER, kind TEXT); INSERT INTO holder VALUES (42,'held-fixture')");
  t.after(() => db.close());
  let last;
  await waitForCondition(() => { last = db.prepare('SELECT pid,kind FROM holder').all(); return last.length === 0; },
    'held resource release', { signal: t.signal, state: () => last, onTimeout: message => t.diagnostic(message) });
});
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await runFixtureChildAsync(process.execPath, ['--test', '--test-reporter=tap', file], { env });
  assert.equal(result.status, 1, result.context);
  assert.match(result.stdout, /held resource release; elapsed \d+ ms; last state:/u);
  assert.match(result.stdout, /"pid":42/u);
  assert.match(result.stdout, /"kind":"held-fixture"/u);
});
