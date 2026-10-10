/** Approved-row edits need an exact person decision or staged SSH receipt [S19,V3]. */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, startFixtureChild as spawn, runFixtureChild as spawnSync, fixtureChildMessage, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';
import { removeFixtureDirectory } from './cleanup-diagnostics.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP_DIRS = [];
const SPEC = `# Approved row edit fixture

## G · Goals
- G1 [approved, must] The existing approved promise. | gate: true | signers: CO
- G2 [draft, aim] A draft promise that can be refined.
- G3 [approved, must] An unaffected approved promise. | gate: true
`;

/** Delete every private repo, key and home created by this file. */
function cleanup() {
  for (const dir of TEMP_DIRS) removeFixtureDirectory(dir);
}

/** Wait for an owned child to close, clearing the timeout as soon as it settles. */
function waitForClose(closePromise, timeoutMs) {
  let timer;
  return Promise.race([
    closePromise,
    new Promise(resolvePromise => { timer = setTimeout(() => resolvePromise(false), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

after(cleanup);

/** Remove ambient Git selectors and agent-shell identity markers from fixture children. */
function isolatedEnvironment(source) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_') || AGENT_SHELL_MARKERS.includes(name) || SSH_SHELL_MARKERS.includes(name)) delete env[name];
  }
  return env;
}

/** Quote one shell argument for the private Git hook executable. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Create a private repo, initialized board, installed hooks and real committed SPEC rows. */
function fixture(t, { signer = false, doctrine = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-approved-row-'));
  TEMP_DIRS.push(dir);
  t.after(() => removeFixtureDirectory(dir));
  const root = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...isolatedEnvironment(process.env),
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'user.useConfigOnly',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'gc.auto',
    GIT_CONFIG_VALUE_1: '0',
    GIT_CONFIG_KEY_2: 'maintenance.auto',
    GIT_CONFIG_VALUE_2: 'false',
  };
  /** Run Git while preserving this fixture's local identity and the hook's active index. */
  function git(...args) {
    return runFixtureGit(args, { cwd: root, env });
  }
  /** Run Pullboard in the fixture repo and retain both output streams for assertions. */
  function pullboard(...args) {
    return runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Approved-row fixture');
  git('config', 'user.email', 'approved-row@example.invalid');
  // Seed the legacy file before init so the conventional rename test starts with one doctrine.
  if (doctrine) writeFileSync(join(root, 'PRACTICE.md'), '# Local rules\n\n## L · Local\n- L1 [approved] Keep the local rule exact. | gate: true\n');
  const initialized = pullboard('init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  const configPath = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, gate: 'true', spec: 'SPEC.md' }, null, 2)}\n`);
  writeFileSync(join(root, 'SPEC.md'), SPEC);
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'promise.test.js'), "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('approved promise remains documented [G1]', () => { assert.match(readFileSync('SPEC.md', 'utf8'), /G1 \\[approved/); });\n");
  git('add', '-A');
  const initial = runFixtureChild('git', ['commit', '-q', '-m', 'chore: initialize approved-row fixture'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(initial.status, 0, fixtureChildMessage(initial));
  if (signer) {
    const key = join(dir, 'co-signing-key');
    const generated = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'approved-row@example.invalid', '-f', key], { encoding: 'utf8' });
    assert.equal(generated.status, 0, fixtureChildMessage(generated));
    git('config', 'user.signingkey', key);
    const added = pullboard('spec', 'signers', 'add', '--key', `${key}.pub`, '--by', 'CO');
    assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
    git('add', '.pullboard/signers', '.pullboard/first-commit', '.pullboard/signers.initial');
    const trustCommit = commit({ root, env });
    assert.equal(trustCommit.status, 0, `${trustCommit.stdout}${trustCommit.stderr}`);
  }
  return { dir, root, env, git, pullboard };
}

test('[C7] cleanup diagnostics capture a forced late writer without hiding ENOTEMPTY', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cleanup-control-'));
  t.after(() => removeFixtureDirectory(directory));
  const target = join(directory, 'repo');
  mkdirSync(target);
  writeFileSync(join(target, 'initial'), 'force a real non-empty-directory error');
  const lateFile = join(target, 'late-write');
  const source = `const fs = require('node:fs'); let descriptor; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { if (data.includes('write')) { descriptor = fs.openSync(${JSON.stringify(lateFile + '.pending')}, 'w'); fs.writeSync(descriptor, 'written after the cleanup failure'); fs.renameSync(${JSON.stringify(lateFile + '.pending')}, ${JSON.stringify(lateFile)}); console.log('late-write-ready'); } if (data.includes('exit')) { if (descriptor !== undefined) fs.closeSync(descriptor); process.exit(0); } }); console.log('writer-ready');`;
  const writer = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  const writerClosed = once(writer, 'close').then(() => true, () => true);
  let output = '';
  writer.stdout.setEncoding('utf8');
  writer.stdout.on('data', chunk => { output += chunk; });
  /** Wait for a child control handshake while keeping the owning test responsible for cleanup. */
  const waitForOutput = async (text) => {
    const deadline = Date.now() + 5_000;
    while (!output.includes(text) && Date.now() < deadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    assert.ok(output.includes(text), `writer output did not include ${text}: ${output}`);
  };
  try {
    await waitForOutput('writer-ready');
    let report = '';
    let failure;
    try {
      removeFixtureDirectory(target, {
        remove: () => {
          try { rmdirSync(target); } catch (error) { failure = error; }
          assert.equal(failure?.code, 'ENOTEMPTY', 'the control uses a real filesystem cleanup failure');
          writer.stdin.write('write\n');
          const deadline = Date.now() + 5_000;
          // Publish the completed write by rename so its mtime cannot change after this handshake.
          while (!existsSync(lateFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          assert.ok(existsSync(lateFile), 'the child made a real late file after cleanup failed');
          throw failure;
        },
        emit: message => { report += message; },
      });
    } catch (error) { failure = error; }
    assert.equal(failure?.code, 'ENOTEMPTY', 'diagnostic capture preserves the original cleanup error');
    assert.match(report, /late-write/);
    const lateMtime = new Date(statSync(lateFile).mtimeMs).toISOString();
    assert.ok(report.includes(lateMtime), `the report records the actual late-file mtime ${lateMtime}`);
    const owners = report.split('open-file owners:\n')[1] ?? '';
    if (process.platform === 'darwin') assert.match(owners, new RegExp(`pid=${writer.pid}\\b`));
    else assert.ok(owners.includes(`pid=${writer.pid}`) || owners.startsWith('unavailable'), owners);
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) writer.stdin.end('exit\n');
    let closed = await waitForClose(writerClosed, 2_000);
    if (!closed) writer.kill('SIGTERM');
    if (!closed) closed = await waitForClose(writerClosed, 2_000);
    if (!closed) writer.kill('SIGKILL');
    if (!closed) await writerClosed;
  }
});

/** Replace one row's prose while preserving status, tier and every trailing field. */
function setRowText(box, id, text) {
  const file = join(box.root, 'SPEC.md');
  const source = readFileSync(file, 'utf8');
  const row = new RegExp(`^(- ${id} \\[[^\\]]+\\] )([^|\\n]*)(.*)$`, 'mu');
  assert.match(source, row, `${id} exists in the fixture`);
  writeFileSync(file, source.replace(row, (_, prefix, _oldText, fields) => `${prefix}${text}${fields ? ' ' : ''}${fields}`));
}

/** Attempt a real commit through the installed Pullboard pre-commit and commit-msg hooks. */
function commit(box, subject = 'docs: update approved row') {
  return runFixtureChild('git', ['commit', '-m', subject], { cwd: box.root, env: box.env, encoding: 'utf8' });
}

/** Stage SPEC.md and any explicitly named supporting receipt files. */
function stage(box, ...paths) {
  box.git('add', '--', 'SPEC.md', ...paths);
}

test('[S19,V3] raw staged changes to an approved row are refused by the real commit hook', (t) => {
  const box = fixture(t);
  const before = box.git('rev-parse', 'HEAD');
  setRowText(box, 'G1', 'A rewrite with no person approval.');
  stage(box);
  const refused = commit(box);
  assert.notEqual(refused.status, 0, `${refused.stdout}${refused.stderr}`);
  assert.match(`${refused.stdout}${refused.stderr}`, /G1 changes approved text.*person/iu);
  assert.equal(box.git('rev-parse', 'HEAD'), before, 'the refused staged rewrite never becomes a commit');
});

test('[B26,S19,V3] exact board approval and decline apply authorize only their approved-row text changes', (t) => {
  const box = fixture(t);
  setRowText(box, 'G1', 'The person approved this exact replacement.');
  const approved = box.pullboard('spec', 'approve', 'G1', '--json');
  assert.equal(approved.status, 0, `${approved.stdout}${approved.stderr}`);
  stage(box);
  const accepted = commit(box, 'docs: apply person-approved wording');
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);

  const declined = box.pullboard('spec', 'decline', 'G1', '--reason', 'The promise is no longer required.', '--json');
  assert.equal(declined.status, 0, `${declined.stdout}${declined.stderr}`);
  const applied = box.pullboard('spec', 'apply', '--json');
  assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
  stage(box);
  const declinedCommit = commit(box, 'docs: apply person-declined wording');
  assert.equal(declinedCommit.status, 0, `${declinedCommit.stdout}${declinedCommit.stderr}`);
  assert.match(readFileSync(join(box.root, 'SPEC.md'), 'utf8'), /G1 \[wont, must\] The promise is no longer required\./u);
});

test('[S19] unchanged approved rows and draft-row wording remain committable', (t) => {
  const box = fixture(t);
  writeFileSync(join(box.root, 'notes.txt'), 'The approved row was not changed.\n');
  box.git('add', 'notes.txt');
  const unchanged = commit(box, 'docs: add unrelated notes');
  assert.equal(unchanged.status, 0, `${unchanged.stdout}${unchanged.stderr}`);

  setRowText(box, 'G2', 'The person refined a draft before approval.');
  stage(box);
  const draft = commit(box, 'docs: refine draft row');
  assert.equal(draft.status, 0, `${draft.stdout}${draft.stderr}`);
});

test('[S19,V3] an exact approval cannot authorize different staged bytes in a partial commit', (t) => {
  const box = fixture(t);
  setRowText(box, 'G1', 'The person approved these exact bytes.');
  const approved = box.pullboard('spec', 'approve', 'G1', '--json');
  assert.equal(approved.status, 0, `${approved.stdout}${approved.stderr}`);

  setRowText(box, 'G1', 'Different text is staged instead.');
  stage(box);
  setRowText(box, 'G1', 'The person approved these exact bytes.');
  const refused = commit(box);
  assert.notEqual(refused.status, 0, `${refused.stdout}${refused.stderr}`);
  assert.match(`${refused.stdout}${refused.stderr}`, /G1 changes approved text.*person/iu);
  assert.match(box.git('show', ':SPEC.md'), /Different text is staged instead\./u, 'the unauthorized text is in the index');
  assert.match(readFileSync(join(box.root, 'SPEC.md'), 'utf8'), /The person approved these exact bytes\./u, 'the different worktree text must not mask staged bytes');
});

test('[S18,S19,S20] pre-commit validates the staged SSH receipt and staged signer trust, not worktree substitutes', (t) => {
  const box = fixture(t, { signer: true });
  setRowText(box, 'G1', 'The signed person-approved wording.');
  const signed = box.pullboard('spec', 'signoff', 'G1', '--by', 'CO', '--json');
  assert.equal(signed.status, 0, `${signed.stdout}${signed.stderr}`);
  const ledger = join(box.root, '.pullboard', 'signoffs.jsonl');
  const validReceipt = readFileSync(ledger, 'utf8');

  box.git('add', 'SPEC.md');
  const unstaged = commit(box, 'docs: use unstaged signoff');
  assert.notEqual(unstaged.status, 0, `${unstaged.stdout}${unstaged.stderr}`);

  const tampered = validReceipt.split('\n').filter(Boolean).map(JSON.parse).map((record) => ({ ...record, on: `${record.on} forged` }));
  writeFileSync(ledger, `${tampered.map((record) => JSON.stringify(record)).join('\n')}\n`);
  box.git('add', '.pullboard/signoffs.jsonl');
  writeFileSync(ledger, validReceipt);
  const stagedTamper = commit(box, 'docs: use forged staged signoff');
  assert.notEqual(stagedTamper.status, 0, `${stagedTamper.stdout}${stagedTamper.stderr}`);
  assert.match(`${stagedTamper.stdout}${stagedTamper.stderr}`, /BAD_SIGNATURE|signature|sign-?off/iu);

  box.git('add', '.pullboard/signoffs.jsonl');
  writeFileSync(join(box.root, '.pullboard', 'signers'), 'untrusted unstaged signer\n');
  const verifiedStaged = commit(box, 'docs: use valid staged signoff');
  assert.equal(verifiedStaged.status, 0, `${verifiedStaged.stdout}${verifiedStaged.stderr}`);
  assert.equal(box.git('show', 'HEAD:.pullboard/signers'), box.git('show', 'HEAD^:.pullboard/signers'), 'the valid committed trust list came from the index');
});

test('[B26,S18,S19] proposed SSH-approved wording and person-declined wording commit through one decision record', (t) => {
  const box = fixture(t, { signer: true });
  const before = readFileSync(join(box.root, 'SPEC.md'), 'utf8');
  const text = 'The exact signed replacement the person approved.';
  const approved = box.pullboard('spec', 'approve', 'G1', '--text', text, '--by', 'CO', '--json');
  assert.equal(approved.status, 0, `${approved.stdout}${approved.stderr}`);
  const record = JSON.parse(approved.stdout).decisions[0];
  assert.ok(record.signature);
  assert.equal(record.type, 'row-decision');
  assert.equal(record.text, text);
  assert.equal(readFileSync(join(box.root, 'SPEC.md'), 'utf8'), before);
  assert.equal(box.pullboard('spec', 'apply').status, 0);
  stage(box, '.pullboard/signoffs.jsonl');
  const accepted = commit(box, 'docs: apply exact signed row decision');
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
  const declined = box.pullboard('spec', 'decline', 'G1', '--reason', 'The person declined this promise.');
  assert.equal(declined.status, 0, `${declined.stdout}${declined.stderr}`);
  assert.equal(box.pullboard('spec', 'apply').status, 0);
  stage(box);
  const declinedCommit = commit(box, 'docs: apply signed-repo person decline');
  assert.equal(declinedCommit.status, 0, `${declinedCommit.stdout}${declinedCommit.stderr}`);
});

test('[S19] repo doctrine approved text has the same exact person-approval commit guard', (t) => {
  const box = fixture(t, { doctrine: true });
  const file = join(box.root, 'PRACTICE.md');
  const before = readFileSync(file, 'utf8');
  writeFileSync(file, before.replace('Keep the local rule exact.', 'An unauthorized local rule.'));
  box.git('add', 'PRACTICE.md');
  const refused = commit(box);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /L1 changes approved text.*person/u);
  writeFileSync(file, before);
  box.git('add', 'PRACTICE.md');
  const approved = box.pullboard('spec', 'approve', 'doctrine:L1', '--text', 'The exact approved local rule.');
  assert.equal(approved.status, 0, `${approved.stdout}${approved.stderr}`);
  assert.equal(box.pullboard('spec', 'apply').status, 0);
  box.git('add', 'PRACTICE.md');
  const accepted = commit(box, 'docs: apply person-approved local rule');
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
});

test('[S19] staged config and row-file renames cannot hide an approved rewrite', (t) => {
  for (const [kind, from, to, id, old, replacement] of [
    ['spec', 'SPEC.md', 'requirements.md', 'G1', 'The existing approved promise.', 'The unauthorized moved promise.'],
    ['practice', 'PRACTICE.md', 'DOCTRINE.md', 'L1', 'Keep the local rule exact.', 'The unauthorized moved local rule.'],
  ]) {
    const box = fixture(t, { doctrine: true });
    const configFile = join(box.root, 'pullboard.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    box.git('mv', from, to);
    writeFileSync(configFile, `${JSON.stringify({ ...config, [kind]: to }, null, 2)}\n`);
    writeFileSync(join(box.root, to), readFileSync(join(box.root, to), 'utf8').replace(old, replacement));
    box.git('add', to, 'pullboard.json');
    const refused = commit(box);
    assert.notEqual(refused.status, 0, `${kind}: changing the path cannot hide an unapproved rewrite`);
    assert.match(`${refused.stdout}${refused.stderr}`, new RegExp(`${id} changes approved text.*person`));
    const approved = box.pullboard('spec', 'approve', `${kind === 'practice' ? 'doctrine:' : ''}${id}`);
    assert.equal(approved.status, 0, `${approved.stdout}${approved.stderr}`);
    const accepted = commit(box, 'docs: move exact person-approved wording');
    assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
  }
});

test('[S19] unstaged config cannot redirect the approval guard away from the staged SPEC', (t) => {
  const box = fixture(t);
  setRowText(box, 'G1', 'An unapproved promise remains staged.');
  stage(box);
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(join(box.root, 'decoy.md'), SPEC);
  writeFileSync(configFile, `${JSON.stringify({ ...config, spec: 'decoy.md' }, null, 2)}\n`);
  const refused = commit(box);
  assert.notEqual(refused.status, 0, `${refused.stdout}${refused.stderr}`);
  assert.match(`${refused.stdout}${refused.stderr}`, /G1 changes approved text.*person/u);
  box.git('rm', '--cached', 'pullboard.json');
  const removedConfig = commit(box, 'docs: remove staged config with unauthorized text');
  assert.notEqual(removedConfig.status, 0, `${removedConfig.stdout}${removedConfig.stderr}`);
  assert.match(`${removedConfig.stdout}${removedConfig.stderr}`, /G1 changes approved text.*person/u);
});
