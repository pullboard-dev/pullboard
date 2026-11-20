/** One criterion freeze finds the primary checkout without a second worktree list, and reads the same doctrine and spec as before [C7,#10822,#5329]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { DOCTRINE_FILE } from '../../../config/index.js';
import { parseSpec } from '../../../spec/index.js';
import { agentDoctrine } from '../../src/io/rulings.js';
import { doctrineFromSource } from '../../src/io/main.js';
import { liveCriterionSpec } from '../../src/io/main-criterion-facts.js';

const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec'];
const SPEC = 'SPEC.md';
const REPLACEMENT = '- X1 [approved, must] A ruling only the primary checkout holds. | gate: check true';

/** A primary checkout with one commit and a linked worktree of it, with the ruling file in the primary only when `present`. */
function checkouts(t, present) {
  const dir = privateFixtureFiles('doctrine-rulings-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const primary = join(dir, 'primary');
  mkdirSync(primary);
  const run = (...args) => runFixtureGit(args, { cwd: primary });
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 't');
  run('config', 'user.email', 't@example.com');
  writeFileSync(join(primary, 'README.md'), 'fixture\n');
  run('add', '-A');
  runFixtureSetupGit(['commit', '-q', '-m', 'fixture'], { cwd: primary });
  const linked = join(dir, 'linked');
  run('worktree', 'add', '-q', '--detach', linked, 'main');
  for (const name of [DOCTRINE_FILE, SPEC]) if (present) writeFileSync(join(primary, name), `## Approved rulings\n${REPLACEMENT}\n`);
  return { primary, linked };
}

/** The applied decisions that put the ruling into the doctrine and into the spec. */
function decisions() {
  const row = parseSpec(`## Approved rulings\n${REPLACEMENT}\n`).rows[0];
  return [DOCTRINE_FILE, SPEC].map(file => ({ kind: file === SPEC ? 'spec' : 'doctrine', applied: true, file, id: row.id, text: row.text, replacement: REPLACEMENT, source: '', decision: 'approve' }));
}

/** The committed facts a freeze holds for a repository with no committed doctrine or spec. */
function facts() {
  return { commit: 'none', specName: SPEC, doctrine: doctrineFromSource(null, DOCTRINE_FILE),
    spec: { ...parseSpec(''), source: null, name: SPEC, exists: false } };
}

/** Run the two freeze reads in `root` while the worktree lists Git is asked for are counted. */
function freeze(root) {
  const real = Object.fromEntries(APIS.map(api => [api, childProcess[api]]));
  let lists = 0;
  for (const api of APIS) {
    childProcess[api] = function counted(...args) {
      const words = Array.isArray(args[1]) ? args[1].map(String) : typeof args[0] === 'string' ? args[0].split(/\s+/u) : [];
      if (String(args[0]).trim().split(/\s+/u)[0].endsWith('git') && words.includes('worktree') && words.includes('list')) lists++;
      return real[api].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try {
    const held = facts();
    const doctrine = agentDoctrine({ info: { root }, doctrine: held.doctrine }, null, { facts: held, decisions: decisions() });
    const spec = liveCriterionSpec(root, held, { item_spec_ids: '' }, decisions());
    return { lists, doctrine, spec };
  } finally {
    for (const api of APIS) childProcess[api] = real[api];
    syncBuiltinESMExports();
  }
}

test('doctrine.io-rulings.freeze-one-worktree-list: clause 1: agentDoctrine and liveCriterionSpec called for one criterion freeze launch at most one git worktree list between them [C7,#10822]', t => {
  const { linked } = checkouts(t, true);
  const { lists } = freeze(linked);
  assert.ok(lists <= 1, `the freeze launched ${lists} worktree lists`);
});

test('doctrine.io-rulings.same-doctrine-and-spec: clause 2: both return the same doctrine and spec with the primary checkout file present and absent [C7,#10822]', t => {
  const present = freeze(checkouts(t, true).linked);
  assert.ok(present.doctrine.rows.some(row => row.id === 'X1'), 'the primary checkout ruling reaches the doctrine');
  assert.ok(present.spec.rows.some(row => row.id === 'X1'), 'the primary checkout ruling reaches the spec');
  const absent = freeze(checkouts(t, false).linked);
  assert.ok(!absent.doctrine.rows.some(row => row.id === 'X1'));
  assert.ok(!absent.spec.rows.some(row => row.id === 'X1'));
  assert.equal(absent.doctrine.rows.length + 1, present.doctrine.rows.length);
  assert.equal(absent.spec.rows.length + 1, present.spec.rows.length);
});
