/** Submit pins one main for every phase, so a landing mid-submit cannot break its seal [C7,V4,H16]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/index.js';
import { runSubmitGate } from '../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Require actual successful native CLI execution before inspecting its document. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Invoke a native command under an explicit fixture session. */
async function asSession(box, session, cwd, ...args) {
  const previous = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = session;
  try { return await box.runLocal(cwd, ...args, '--json'); }
  finally {
    if (previous === undefined) delete box.env.CODEX_THREAD_ID;
    else box.env.CODEX_THREAD_ID = previous;
  }
}

/** Join an independent detached worktree at a commit under its own session. */
async function seat(box, name, lane, commit) {
  const path = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, commit);
  return { path, id: document(await asSession(box, name, path, 'join', lane)).agent, session: name };
}

test('a companion submit seals when main advances during its proof phase, the #1668 shape [C7,V4,H16]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const moved = join(box.dir, 'main-moved');
  const marker = join(box.dir, 'criterion-ran');
  const gate = join(box.dir, 'proof-gate.cjs');
  const check = join(box.dir, 'criterion.cjs');
  // The criterion only records that it ran. The proof gate then lands a commit on main, between the criterion's
  // receipt and the proof's receipt, exactly as a train does during submit.
  writeFileSync(check, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`);
  writeFileSync(gate, [
    "const fs = require('node:fs'); const cp = require('node:child_process');",
    `if (fs.existsSync(${JSON.stringify(marker)}) && !fs.existsSync(${JSON.stringify(moved)})) {`,
    `  fs.writeFileSync(${JSON.stringify(moved)}, 'moved\\n');`,
    `  fs.writeFileSync(${JSON.stringify(join(box.repo, 'landed.txt'))}, 'landed\\n');`,
    `  cp.execFileSync('git', ['-C', ${JSON.stringify(box.repo)}, 'add', 'landed.txt']);`,
    `  cp.execFileSync('git', ['-C', ${JSON.stringify(box.repo)}, 'commit', '-q', '-m', 'feat(core): train lands during submit [G1]']);`,
    '}',
  ].join('\n'));
  const policyFile = join(box.repo, 'pullboard.json');
  const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  writeFileSync(policyFile, JSON.stringify({ ...policy, gate: `node '${gate}'` }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: gate that lands during proof [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const id = document(await fixtureAdd(box.runLocal, box.repo, 'web', 'Companion submit across a landing',
    '--criterion', 'The feature submits.', '--specs', 'G1', '--check', `node '${check}'`, '--json')).item.item_id;
  document(await asSession(box, 'pin-builder', box.web, 'claim', String(id)));
  const previous = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = 'pin-builder';
  try { assert.equal(helpers.commitFile(box, box.web, 'web/feature.txt', 'feature\n', 'feat(web): add feature [G1]').status, 0); }
  finally { if (previous === undefined) delete box.env.CODEX_THREAD_ID; else box.env.CODEX_THREAD_ID = previous; }
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  const author = await seat(box, 'pin-author', 'api', submitted);
  mkdirSync(join(author.path, 'api'), { recursive: true });
  writeFileSync(join(author.path, 'api/companion.txt'), 'required companion\n');
  box.git(author.path, 'add', 'api/companion.txt');
  const patchFile = join(box.dir, 'companion.patch');
  writeFileSync(patchFile, box.git(author.path, 'diff', '--cached', '--binary') + '\n');
  document(await box.runLocal(box.repo, 'patch', 'attach', String(id), patchFile, '--key', 'companion-v1', '--author', author.id, '--source', submitted, '--json'));
  const submit = await asSession(box, 'pin-builder', box.web, 'submit', String(id));
  assert.equal(submit.code, 0, submit.out);
});

test('submit refuses a pinned main that is not an ancestor of main, by name [C7,V4]', async (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  const detached = box.git(box.repo, 'commit-tree', box.git(box.repo, 'rev-parse', 'HEAD^{tree}'), '-p', head, '-m', 'feat(core): side commit off main [G1]');
  const config = configFromSource(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  await assert.rejects(runSubmitGate(box.repo, config, { base: null, trunk: detached, check: null, agent: 'pin-test', item: '1' }),
    error => error.code === 'SUBMIT_PIN_NOT_MAIN' && /not an ancestor of main/.test(error.message));
});
