/** @pullboard-test-input apps/cli/src/io/commands/main-red-files.js apps/cli/tests/fixtures/next/take.js */
/** pullboard main-red-files lets the coordinator print, replace and clear the gate's main-red file list in board meta [C7,#12133]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { main } from '../../fixtures/native.js';
import { COMMANDS } from '../../../src/io/commands/index.js';
import { coordinatorHelp } from '../../../src/logic/help/coordinator.js';

const KEY = 'gate_main_red_files';
const stored = box => store.readBoardMeta(box.board.db, KEY);

/** The printed path lines: every output line before the CLI's closing `next:` hint, which must be the only other line. */
function listed(out) {
  const lines = out.trim() ? out.trim().split('\n') : [];
  const hints = lines.filter(line => line.startsWith('next: '));
  assert.ok(hints.length <= 1 && (!hints.length || lines.at(-1) === hints[0]), `only a closing next: hint follows the paths: ${out}`);
  return lines.filter(line => !line.startsWith('next: '));
}

/** Run the CLI entry without --json, so the printed lines are the plain output. */
async function plain(box, cwd, args) {
  let out = '', err = '';
  const code = await main(args, { cwd, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  return { code, out, err };
}

test('cli.main-red-files.coordinator-sets-list: clause 1: as the coordinator, set writes the sorted, deduplicated paths to board_meta gate_main_red_files, the bare command prints them one per line, and --clear writes [] [C7,#12133]', async t => {
  const box = await fixture(t);
  const set = await cli(box, box.root, ['main-red-files', 'set', 'packages/b/x.test.js', 'apps/a.test.js', 'packages/b/x.test.js']);
  assert.equal(set.code, 0, set.err || set.out);
  assert.equal(stored(box), JSON.stringify(['apps/a.test.js', 'packages/b/x.test.js']), 'sorted and deduplicated');
  assert.deepEqual(set.document.files, ['apps/a.test.js', 'packages/b/x.test.js']);
  const printed = await plain(box, box.root, ['main-red-files']);
  assert.equal(printed.code, 0, printed.err || printed.out);
  assert.deepEqual(listed(printed.out), ['apps/a.test.js', 'packages/b/x.test.js'], 'one path per line');
  const replaced = await cli(box, box.root, ['main-red-files', 'set', 'go/c_test.go']);
  assert.equal(replaced.code, 0, replaced.err || replaced.out);
  assert.equal(stored(box), JSON.stringify(['go/c_test.go']), 'set replaces the list');
  const cleared = await cli(box, box.root, ['main-red-files', '--clear']);
  assert.equal(cleared.code, 0, cleared.err || cleared.out);
  assert.equal(stored(box), '[]', '--clear writes an empty array');
  const empty = await plain(box, box.root, ['main-red-files']);
  assert.equal(empty.code, 0, empty.err || empty.out);
  assert.deepEqual(listed(empty.out), [], 'an empty list prints no path');
});

test('cli.main-red-files.refuses-unchanged: clause 2: a seat is refused COORDINATOR_ONLY, and an absolute path, a . or .. segment, or a newline or NUL is refused USAGE naming the path, with gate_main_red_files unchanged [C7,#12133]', async t => {
  const box = await fixture(t);
  const before = await cli(box, box.root, ['main-red-files', 'set', 'apps/kept.test.js']);
  assert.equal(before.code, 0, before.err || before.out);
  const kept = stored(box);
  const seat = await cli(box, box.seats.builder.path, ['main-red-files', 'set', 'apps/other.test.js']);
  assert.notEqual(seat.code, 0, 'a seat cannot write the list');
  assert.match(seat.err + seat.out, /COORDINATOR_ONLY/u);
  const seatClear = await cli(box, box.seats.builder.path, ['main-red-files', '--clear']);
  assert.match(seatClear.err + seatClear.out, /COORDINATOR_ONLY/u, 'a seat cannot clear the list');
  for (const bad of ['/abs/path.test.js', 'apps/../secret.test.js', './apps/a.test.js', 'apps/./a.test.js', '..', 'apps/a\nb.test.js', 'apps/a\0b.test.js']) {
    const refused = await plain(box, box.root, ['main-red-files', 'set', 'apps/fine.test.js', bad]);
    assert.notEqual(refused.code, 0, `${JSON.stringify(bad)} is refused`);
    assert.match(refused.err + refused.out, /USAGE/u);
    assert.ok((refused.err + refused.out).includes(JSON.stringify(bad)), `the refusal names ${JSON.stringify(bad)}`);
  }
  assert.equal(stored(box), kept, 'no refused call changed the list');
});

test('cli.main-red-files.discovered-and-listed: clause 3: the command is discovered from its own file and listed in the Coordinator help group [C7,#12133]', async t => {
  assert.equal(typeof COMMANDS['main-red-files'], 'function', 'discovered from apps/cli/src/io/commands/main-red-files.js');
  assert.match(coordinatorHelp, /^Coordinator\n[\s\S]*pullboard main-red-files \[set <path> \[<path> \.\.\.\] \| --clear\]/u);
  const box = await fixture(t);
  const help = await plain(box, box.root, ['help', '--all']);
  assert.equal(help.code, 0, help.err || help.out);
  assert.match(help.out, /pullboard main-red-files/u, 'pullboard help shows the line');
});
