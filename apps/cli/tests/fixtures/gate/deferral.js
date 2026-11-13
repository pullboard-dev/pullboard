/** @pullboard-test-input packages/sandbox/src/io/trusted/policy.js */
/** Shared large-selection project for the deferred-landing journeys (C7). */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fixtureAdd } from '../testkit.js';
import {
  BROWSER_SLOT_HELD_ENV,
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
} from '../../../../../packages/resources/index.js';
import { fixtureMachineSettings } from '../testkit.js';
import { fixtureCommittedPolicy } from '../testkit.js';
import { fixtureOpenBoard } from '../testkit.js';

/**
 * Bind the deferral fixtures to one journey file's e2e helpers, so each file cleans up its own sandboxes.
 * Why: `store` comes from the journey, which may import the board; the shared fixture stays out of that cell.
 */
export function makeDeferralFixtures(e2e, store) {
  /** A web project whose one source file is imported by thirty test files, each recording its own run. */
  function largeSelectionProject(deferAbove, { inline = false } = {}) {
    const box = e2e.project('true');
    // Landing diagnostics require TAP completion evidence on both Node 22 and Node 24.
    box.boardFile = fixtureCommittedPolicy(box, { submitGate: 'landing', affectedTests: 'node --test --test-reporter=tap',
      submitInvariants: ['web/guard.test.js'], ...(inline ? { gate: 'node --test --test-reporter=tap web/gate-check.test.js' } : { landing: { perItem: false, manualOverride: true, publish: 'separate' } }), ...(deferAbove ? { submitDeferAbove: deferAbove } : {}) });
    if (inline) {
      // An inline landing pushes its gated tip, so it needs a remote; its gate only checks for a red marker file.
      box.git(box.dir, 'init', '-q', '--bare', join(box.dir, 'origin.git'));
      box.git(box.repo, 'remote', 'add', 'origin', join(box.dir, 'origin.git'));
    }
    writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(box.repo, 'web'), { recursive: true });
    writeFileSync(join(box.repo, 'web/core.js'), 'export const value = 1;\n');
    writeFileSync(join(box.repo, 'web/fix.js'), 'export const fixed = false;\n');
    const record = () => `import { appendFileSync } from 'node:fs';\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\n`;
    writeFileSync(join(box.repo, 'web/gate-check.test.js'), `${record()}import { existsSync } from 'node:fs';\n`
      + `test('no red marker [G1]', () => assert.equal(existsSync(new URL('./RED', import.meta.url)), false));\n`);
    writeFileSync(join(box.repo, 'web/guard.test.js'), `${record()}test('guard [G1]', () => { appendFileSync(process.env.DEFER_MARKER, 'guard\\n'); });\n`);
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(join(box.repo, `web/selected-${String(index).padStart(2, '0')}.test.js`), `${record()}import { value } from './core.js';\nimport { fixed } from './fix.js';\n`
        + `test('selected ${index} [G1]', () => { appendFileSync(process.env.DEFER_MARKER, '${index}\\n'); assert.notEqual(value, 'red'); assert.ok(value !== 'needs-fix' || fixed); });\n`);
    }
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: thirty tests import one source');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    box.env.DEFER_MARKER = join(box.dir, 'ran.log');
    // The runner's own slot leases are not this fixture's.
    for (const name of [BROWSER_SLOT_HELD_ENV, GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV]) delete box.env[name];
    // The landing runs the deferred files on this machine: give the fixture its own gate and browser slots.
    mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gateSlots: 1, browserSlots: 1, gate: { memoryFloorMB: 0, timingRunner: false } });
    delete box.env.NODE_TEST_CONTEXT;
    const ran = () => existsSync(box.env.DEFER_MARKER) ? readFileSync(box.env.DEFER_MARKER, 'utf8').trim().split('\n').filter(Boolean) : [];
    /** Add, claim, change the shared source and submit one item, returning its receipt and what ran. */
    const submitChange = (value, { cwd = box.web, files = [] } = {}) => {
      const added = fixtureAdd(box.run, box.repo, 'web', `Set the value to ${value}`, '--specs', 'G1', '--criterion', 'The source exists.', '--check', 'test -f web/core.js', '--wait', '--json');
      assert.equal(added.code, 0, added.err);
      const id = JSON.parse(added.out).item.item_id;
      const claimed = box.run(cwd, 'claim', String(id));
      assert.equal(claimed.code, 0, `claim: ${claimed.err}${claimed.out}`);
      for (const [path, text] of files) writeFileSync(join(cwd, path), text);
      assert.equal(e2e.commitFile(box, cwd, files.length ? files[0][0] : 'web/core.js', files.length ? files[0][1] : `export const value = ${JSON.stringify(value)};\n`, `feat(web): set the value [G1]`).status, 0, 'the item change commits');
      rmSync(box.env.DEFER_MARKER, { force: true });
      const submitted = box.run(cwd, 'submit', String(id), '--json');
      assert.equal(submitted.code, 0, submitted.err + submitted.out);
      const receipt = JSON.parse(submitted.out);
      const proof = onLocalBoard(box, board => JSON.parse(store.events(board, { itemId: id }).findLast(row => row.event_kind === 'submit').event_detail));
      return { id, receipt, proof, ran: ran() };
    };
    /** Accept one submitted item as the coordinator, at its exact commit. */
    const accept = (id, commit) => {
      box.git(box.repo, 'switch', '-q', '--detach', commit);
      try {
        const verified = box.run(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The source exists.');
        assert.equal(verified.code, 0, `verify: ${verified.err}${verified.out}`);
      }
      finally { box.git(box.repo, 'switch', '-q', 'main'); }
    };
    return { box, ran, submitChange, accept };
  }

  /** Read a fixture's real board through its public interface. */
  function onLocalBoard(box, action) {
    const board = fixtureOpenBoard(box);
    try { return action(board); } finally { store.closeBoard(board); }
  }

  /** Locate only durable logs belonging to this private fixture's actual native landing batches. */
  function deferredLandingLogs(box) {
    const directory = join(box.repo, '.git', 'pullboard', 'landings');
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { recursive: true }).filter(path => path.endsWith('.log'))
      .map(path => ({ path: join(directory, path), text: readFileSync(join(directory, path), 'utf8') }));
  }

  return { largeSelectionProject, onLocalBoard, deferredLandingLogs };
}
