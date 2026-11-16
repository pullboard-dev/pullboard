/** The file-board open ratchet runs in the always-run static registry, only when its setting is on, and costs nothing on an unrelated change [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { STATIC_CHECKS } from '../../../../heavy.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { fixtureMachineSettings } from '../../../fixtures/testkit.js';

const check = STATIC_CHECKS.find(entry => entry.name === 'board-file-opens');
const OPEN = "import { openBoard } from '../board.js';\nopenBoard('/tmp/x.db');\n";
const NAMED = "// @pullboard-board-file journey: proves the file lock\nopenBoard('/tmp/x.db');\n";

/** Point machine storage at a fresh folder holding `settings` for one test; the restore runs when the test ends. */
function machine(t, settings) {
  const home = privateFixtureFiles('board-opens-').root;
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  fixtureMachineSettings(home, settings);
  t.after(() => {
    if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

/** Run the class on one changed path whose source is `source`. */
const run = (file, source) => check.run({ root: process.cwd(), files: [file], read: () => ({ file, source }) });

test('clause 1: with the setting on, a new unannotated board open in a changed test is refused at the always-run static checks [C7]', t => {
  assert.ok(check, 'the always-run static registry lists board-file-opens');
  machine(t, { gate: { boardOpensCheck: true } });
  const found = run('packages/x/tests/new.test.js', OPEN);
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], /^packages\/x\/tests\/new\.test\.js:2: unclassified file board open/u);
  assert.deepEqual(run('packages/x/tests/new.test.js', NAMED), [], 'a named boundary is not debt');
});

test('clause 2: with gate.boardOpensCheck off (the default), the same change is not refused [C7]', t => {
  machine(t, {});
  assert.deepEqual(run('packages/x/tests/new.test.js', OPEN), []);
  machine(t, { gate: { boardOpensCheck: false } });
  assert.deepEqual(run('packages/x/tests/new.test.js', OPEN), []);
});

test('clause 3: a change with no test file leaves the board-open check silent without reading anything [C7]', t => {
  machine(t, { gate: { boardOpensCheck: true } });
  const read = () => { throw new Error('no file may be read'); };
  assert.deepEqual(check.run({ root: process.cwd(), files: ['packages/x/src/io/main.js', 'README.md'], read }), []);
});
