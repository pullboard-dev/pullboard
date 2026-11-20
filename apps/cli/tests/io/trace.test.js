/** A blocked commit hook appends one trace line that names its refusal code, the seat and the hook, and prints what it always printed [C7,#12043]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../fixtures/e2e.js';
import { captureCommandInProcess } from '../fixtures/process.js';
import { runCliInProcess } from '../fixtures/process.js';
import { fixtureAdd } from '../fixtures/testkit.js';
import { runThinHook } from '../../src/io/hook/thin.js';
import { readTraceLines } from '../../src/io/trace.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project whose web seat holds one claimed item, so a seat is bound and a message could earn its trailer. */
async function claimedProject() {
  const box = e2e.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Trace item', '--criterion', 'hook blocks are traced', '--json');
  assert.equal(added.code, 0, added.err);
  const claimed = await box.runLocal(box.web, 'claim', String(JSON.parse(added.out).item.item_id));
  assert.equal(claimed.code, 0, claimed.err);
  return box;
}

/** Every trace line of the checkout's repository whose command is `hook`. */
function linesFor(box, cwd, hook) {
  const common = box.git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  return readTraceLines(common).filter(line => line.command === hook);
}

/** Run the thin hook entry the installed hooks run, in this process, and answer its status and stderr. */
function thin(box, cwd, args) {
  return captureCommandInProcess((argv, streams) => runThinHook(argv, streams), args, { cwd, env: box.env });
}

test('cli.io-trace.hook-refusals-carry-code: clause 1: a pre-commit block and a commit-msg block each append one trace line with refusal.code set, the seat, and the hook name as the attempted command, and the stderr text is byte-identical to the full dispatcher\'s [C7,#12043]', async () => {
  const box = await claimedProject();
  mkdirSync(join(box.web, 'api'), { recursive: true });
  writeFileSync(join(box.web, 'api', 'outside.txt'), 'a path the web lane does not own\n');
  box.git(box.web, 'add', '-A');
  const pre = await thin(box, box.web, ['hook', 'pre-commit']);
  assert.equal(pre.status, 1, pre.stderr);
  const preLines = linesFor(box, box.web, 'pre-commit');
  assert.equal(preLines.length, 1, 'one trace line for the pre-commit block');
  assert.ok(preLines[0].refusal?.code, 'the pre-commit line carries a refusal code');
  assert.ok(preLines[0].agent, 'the pre-commit line names the seat');
  assert.equal(preLines[0].exit, 1);
  const full = await runCliInProcess(['hook', 'pre-commit'], { cwd: box.web, env: box.env });
  assert.equal(pre.stderr, full.stderr, 'the thin hook prints what the full dispatcher prints');

  const file = join(box.web, 'COMMIT_EDITMSG');
  writeFileSync(file, 'add the page [G1]\n');
  const msg = await thin(box, box.web, ['hook', 'commit-msg', file]);
  assert.equal(msg.status, 1, msg.stderr);
  const msgLines = linesFor(box, box.web, 'commit-msg');
  assert.equal(msgLines.length, 1, 'one trace line for the commit-msg block');
  assert.ok(msgLines[0].refusal?.code, 'the commit-msg line carries a refusal code');
  assert.ok(msgLines[0].agent, 'the commit-msg line names the seat');
  const fullMsg = await runCliInProcess(['hook', 'commit-msg', file], { cwd: box.web, env: box.env });
  assert.equal(msg.stderr, fullMsg.stderr, 'the thin commit-msg hook prints what the full dispatcher prints');
});
