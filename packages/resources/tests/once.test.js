/** An open of a current resource pool takes no write turn, and one process holds one connection however many leases it takes [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { cellProject } from '../../store/tests/fixtures/cell.js';
import { runFixtureChildAsync } from '../../gate/tests/fixtures/child.js';

const index = JSON.stringify(new URL('../index.js', import.meta.url).href);

/**
 * Run a fixture child against a private machine pool and return what it prints. The child counts the write
 * transactions it begins by wrapping DatabaseSync's exec before the pool module loads.
 */
async function child(t, box, body) {
  const source = `import { DatabaseSync } from 'node:sqlite';
let begins = 0;
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) { if (/BEGIN IMMEDIATE/u.test(sql)) begins++; return exec.call(this, sql); };
const { listResources, takeResource } = await import(${index});
const root = process.cwd();
${body}`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 30_000, // budget: one private pool and its own leases, no network.
  });
  assert.equal(result.status, 0, `${result.context}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** A private project whose machine pool no other test shares. */
function project(t) {
  const box = cellProject(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  return box;
}

test('resources.once.the-first-open-sets-the-schema: clause 1: the first open sets the schema up in a write turn and a later process opens it with none [C7]', async t => {
  const box = project(t);
  const first = await child(t, box, 'listResources({ scope: "machine", root }); process.stdout.write(JSON.stringify({ begins }));');
  assert.equal(first.begins, 2, 'a new pool takes one setup turn and one listing turn');
  const later = await child(t, box, 'listResources({ scope: "machine", root }); listResources({ scope: "machine", root }); process.stdout.write(JSON.stringify({ begins }));');
  assert.equal(later.begins, 2, 'a current pool takes only the two listing turns: its opens take none');
});

test('resources.once.ten-leases-held-at-once-in: clause 2: ten leases held at once in one process share one connection to the pool [C7]', async t => {
  const box = project(t);
  const result = await child(t, box, `import { execFileSync } from 'node:child_process';
const leases = await Promise.all(Array.from({ length: 10 }, (_, index) => takeResource({ name: 'shard-' + index, capacity: 1, scope: 'machine', root, agent: 'shard-' + index })));
const names = execFileSync('lsof', ['-n', '-P', '-Fn', '-p', String(process.pid)], { encoding: 'utf8' }).split('\\n')
  .filter(line => line.startsWith('n') && line.endsWith('resources.sqlite'));
for (const lease of leases) lease.release();
process.stdout.write(JSON.stringify({ handles: names.length, begins }));`);
  assert.equal(result.handles, 1, `one process holds one handle on resources.sqlite, not one per lease: ${result.handles}`);
});
