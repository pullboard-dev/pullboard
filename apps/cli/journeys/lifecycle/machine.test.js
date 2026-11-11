/** @pullboard-test-input apps/cli/pullboard.js docs/lifecycle.md */
/** Lifecycle declaration documentation and CLI parity, moved intact from machine.test.js [C7,M1,P4]. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import * as machineRules from '../../../../packages/state/index.js';
import { HELP } from '../../index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

const copy = () => structuredClone(machineRules.MACHINE);
const BIN = join(import.meta.dirname, '../../pullboard.js');

test('docs/lifecycle.md is the page the declaration generates, so a stale copy fails [M1, P4]', () => {
  const page = machineRules.lifecycleMarkdown();
  const committed = fs.readFileSync(new URL('../../../../docs/lifecycle.md', import.meta.url), 'utf8');
  assert.equal(committed, page, 'docs/lifecycle.md is stale; regenerate it: node apps/cli/pullboard.js lifecycle > docs/lifecycle.md');
  assert.match(page, /```mermaid\nstateDiagram-v2\n {2}\[\*\] --> open\n/);
  for (const state of machineRules.MACHINE.states) assert.match(page, new RegExp(`^\\| ${state.id}( \\(final\\))? \\|`, 'm'), `${state.id} has a row`);
  for (const move of machineRules.MACHINE.moves) {
    assert.match(page, new RegExp(`^\\| ${move.verb} \\| ${move.from.join(', ')} \\| ${move.to} \\|`, 'm'), `${move.verb} has a row`);
    for (const from of move.from) assert.ok(page.includes(`  ${from} --> ${move.to}: ${move.verb}`), `the diagram draws ${move.verb} from ${from}`);
    for (const id of machineRules.effectiveGuards(move)) assert.ok(page.includes(id), `${move.verb}'s guard ${id} is listed`);
  }
  for (const [state, guards] of Object.entries(machineRules.MACHINE.exitGuards)) assert.ok(page.includes(`| ${state} | ${guards.join(', ')} |`), `${state}'s exit guards are listed`);
  const codes = new Set([...machineRules.MACHINE.guards.flatMap((guard) => [guard.refuse, ...(guard.alsoRefuses ?? []).map((entry) => entry.code)]), ...machineRules.MACHINE.moves.flatMap((move) => [move.refuse, ...(move.alsoRefuses ?? []).map((entry) => entry.code)]), machineRules.MACHINE.unknownMove.refuse].filter(Boolean));
  for (const code of codes) assert.match(page, new RegExp(`^\\| ${code} \\|`, 'm'), `${code} is in the refusal table`);
});

test('the lifecycle page versions fresh and historical family matching and explains unknown families [O2, O3]', () => {
  const page = machineRules.lifecycleMarkdown();
  assert.match(page, /^\| O2_FAMILY_MATCH \| strict reviews require different declared vendor families; the existing vendor policy and explicit board or item family requirements also apply, when the item is strict, verify\.family is require, an item requires a family, or requireReviewFamilies is on for unknown families \| ask the coordinator for a verifier from another declared family \|$/m);
  for (const verb of ['reserve', 'accept', 'reject']) {
    assert.match(page, new RegExp(`^\\| ${verb} \\| .*familyAllows \\(SAME_FAMILY or LINE_SETTING_RANGE or O2_FAMILY_MATCH\\)`, 'm'));
  }
});

test('the page and the help follow the declaration: a new move appears in both [M1, P4]', () => {
  const machine = copy();
  machine.moves.push({ verb: 'shelve', from: ['open'], to: 'withdrawn', by: ['coordinator'], refuse: 'CLOSED', guards: ['joined', 'coordinatorOnly', 'noteGiven', 'itemExists', machineRules.IN_STATE], sets: ['item_withdrawn_reason'] });
  assert.ok(!machineRules.lifecycleMarkdown().includes('shelve'));
  assert.ok(machineRules.lifecycleMarkdown(machine).includes('  open --> withdrawn: shelve'));
  assert.match(machineRules.lifecycleMarkdown(machine), /^\| shelve \| open \| withdrawn \| coordinator \|/m);
  assert.match(machineRules.machine_lifecycleHelp(machine), /^ {2}coordinator +.*\bshelve\b/m);
  assert.doesNotMatch(machineRules.machine_lifecycleHelp(machine), /^ {2}agent +.*\bshelve\b/m);
});

test('pullboard help lists each role\'s moves from the declaration, and pullboard lifecycle prints the page [M1, P4]', () => {
  const ownCliEnv = { ...process.env, PULLBOARD_OWN_CLI: '1' };
  const help = runFixtureChild(process.execPath, [BIN, 'help', '--all'], { encoding: 'utf8', env: ownCliEnv, cwd: tmpdir() });
  assert.equal(help.status, 0, help.stderr);
  for (const role of machineRules.MACHINE.roles) {
    const line = help.stdout.split('\n').find((text) => text.startsWith(`  ${role} `));
    assert.ok(line, `help has a line for ${role}`);
    const listed = line.slice(role.length + 2).split(',').map((part) => part.trim().split(' ')[0]).filter(Boolean);
    assert.deepEqual(listed.sort(), [...new Set(machineRules.MACHINE.moves.filter((move) => move.by.includes(role)).map((move) => move.verb))].sort(), `${role}'s moves`);
  }
  assert.ok(HELP.all.includes(machineRules.lifecycleHelp), 'the full help screen carries the generated section, not a typed copy');
  const printed = runFixtureChild(process.execPath, [BIN, 'lifecycle', '--detail'], { encoding: 'utf8', env: ownCliEnv, cwd: tmpdir() });
  assert.equal(printed.status, 0, printed.stderr);
  assert.ok(printed.stdout.startsWith(machineRules.lifecycleMarkdown().trimEnd()), 'the command prints the generated page before the native CLI footer');
});

