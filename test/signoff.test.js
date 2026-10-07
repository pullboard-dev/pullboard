/** SSH sign-off opt-in, rotation, row requirements and tamper rejection [S17,S18,S19,S20,S21]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { canonical } from '../src/signature.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const SPEC = `# Sign-off fixture

## G · Goals
- G1 [approved, must] Exact row text is signed. | gate: test/proof.test.js | signers: CO,AB
`;

/** Quote a source-runner path literally for the fixture's POSIX hook shim. */
function shellWord(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Create a throwaway OpenSSH Ed25519 private and public key pair. */
function makeKey(path) {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test@example.invalid', '-f', path], { stdio: 'pipe' });
  return { privateKey: path, publicKey: `${path}.pub` };
}

/** Build a real isolated repo with a cited test, a private board and synthetic Git identity. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-signature-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const keys = join(dir, 'keys');
  mkdirSync(root);
  mkdirSync(keys);
  const co = makeKey(join(keys, 'co'));
  const ab = makeKey(join(keys, 'ab'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(binDir, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'CO',
    GIT_AUTHOR_EMAIL: 'co@example.invalid',
    GIT_COMMITTER_NAME: 'CO',
    GIT_COMMITTER_EMAIL: 'co@example.invalid',
    PULLBOARD_HOME: join(dir, 'home'),
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'CO');
  git('config', 'user.email', 'co@example.invalid');
  git('config', 'user.signingkey', co.privateKey);
  const initialized = run('init');
  assert.equal(initialized.status, 0, initialized.stderr);
  writeFileSync(join(root, 'SPEC.md'), SPEC);
  writeFileSync(join(root, 'PRACTICE.md'), '# Practice\n');
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'proof.test.js'), "import { test } from 'node:test';\ntest('proof [G1]', () => {});\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: initialize sign-off fixture');
  return { dir, root, keys, co, ab, env, git, run };
}

/** Run a spec command and include both output streams in a useful test assertion. */
function succeeds(box, ...args) {
  const result = box.run('spec', ...args);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result;
}

test('[S17,S18,S19,S20,S21] signed rows require every named principal and survive a shallow clone', (t) => {
  const box = fixture(t);
  const first = box.git('rev-list', '--max-parents=0', 'HEAD');
  assert.equal(succeeds(box, 'signers', 'add', '--key', box.co.publicKey, '--by', 'CO').status, 0);
  assert.equal(readFileSync(join(box.root, '.pullboard/first-commit'), 'utf8').trim(), first);
  succeeds(box, 'signoff', 'G1', '--by', 'CO', '--note', 'checked the exact row');
  const missingPrincipal = box.run('spec', 'check');
  assert.notEqual(missingPrincipal.status, 0);
  assert.match(missingPrincipal.stderr, /UNLISTED_SIGNER/u);
  const partial = JSON.parse(succeeds(box, 'unmet', '--json').stdout);
  assert.ok(partial.rows.some((row) => row.id === 'G1'), 'the row waits until both named principals have signed');
  const page = join(box.dir, 'spec.html');
  succeeds(box, 'view', '--out', page);
  assert.match(readFileSync(page, 'utf8'), /signed CO[^<]*; waiting for AB/);

  succeeds(box, 'signers', 'add', '--key', box.ab.publicKey, '--by', 'AB');
  assert.match(succeeds(box, 'check').stdout, /0 errors/);
  box.git('config', 'user.signingkey', box.ab.privateKey);
  succeeds(box, 'signoff', 'G1', '--by', 'AB', '--note', 'second required signer');
  assert.doesNotMatch(succeeds(box, 'unmet').stdout, /G1 \[must\]/);

  const signedRows = readFileSync(join(box.root, '.pullboard/signoffs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(signedRows.some((record) => record.type === 'signers' && record.by === 'CO'), 'rotation is signed by a principal in the previous version');
  assert.ok(signedRows.filter((record) => record.type === 'row').every((record) => record.firstCommit === first && record.commit));
  assert.ok(signedRows.filter((record) => record.type === 'row').every((record) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(record.on)), 'signed receipts include the verification time');

  writeFileSync(join(box.root, 'SPEC.md'), SPEC.replace('Exact row text is signed.', 'The exact approved row text is signed.'));
  const stale = JSON.parse(succeeds(box, 'show', 'G1', '--json').stdout);
  assert.equal(stale.standing.stale.length, 2, 'cryptographically valid records become stale when row text changes');

  box.git('add', 'SPEC.md', '.pullboard/signers', '.pullboard/signers.initial', '.pullboard/first-commit', '.pullboard/signoffs.jsonl');
  box.git('commit', '-q', '-m', 'chore: record signed sign-offs');
  box.git('commit', '--amend', '--no-edit', '-q');
  assert.match(succeeds(box, 'check').stdout, /0 errors/, 'rewritten history keeps the self-contained signatures valid');
  box.git('checkout', '-q', '-b', 'rebase-base', first);
  writeFileSync(join(box.root, 'unrelated.txt'), 'rebased history still has the original trust anchor\n');
  box.git('add', 'unrelated.txt');
  box.git('commit', '-q', '-m', 'docs: add an unrelated base change');
  box.git('checkout', '-q', 'main');
  box.git('rebase', '--quiet', 'rebase-base');
  assert.match(succeeds(box, 'check').stdout, /0 errors/, 'rebase keeps signed receipts valid');
  box.git('reset', '--soft', first);
  box.git('commit', '-q', '-m', 'chore: squash signed receipt history');
  assert.match(succeeds(box, 'check').stdout, /0 errors/, 'squash keeps signed receipts valid');
  succeeds(box, 'signoff', 'G1', '--by', 'AB', '--note', 'checked after rewriting history');
  const rewritten = readFileSync(join(box.root, '.pullboard/signoffs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(rewritten.firstCommit, first, 'new signatures after a rewrite use the recorded root');
  box.git('add', '.pullboard/signoffs.jsonl');
  box.git('commit', '-q', '-m', 'chore: sign after rewriting history');
  const clone = join(box.dir, 'shallow');
  execFileSync('git', ['clone', '-q', '--depth=1', `file://${box.root}`, clone], { env: box.env, stdio: 'pipe' });
  const shallowCheck = spawnSync(process.execPath, [BIN, 'spec', 'check'], { cwd: clone, env: box.env, encoding: 'utf8' });
  assert.equal(shallowCheck.status, 0, `${shallowCheck.stdout}${shallowCheck.stderr}`);
  execFileSync('git', ['config', 'user.signingkey', box.ab.privateKey], { cwd: clone, env: box.env });
  const shallowSign = spawnSync(process.execPath, [BIN, 'spec', 'signoff', 'G1', '--by', 'AB'], { cwd: clone, env: box.env, encoding: 'utf8' });
  assert.equal(shallowSign.status, 0, `${shallowSign.stdout}${shallowSign.stderr}`);
  const shallowRecord = readFileSync(join(clone, '.pullboard/signoffs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(shallowRecord.firstCommit, first);
  const signedCheck = spawnSync(process.execPath, [BIN, 'spec', 'check'], { cwd: clone, env: box.env, encoding: 'utf8' });
  assert.equal(signedCheck.status, 0, `${signedCheck.stdout}${signedCheck.stderr}`);
});

test('[S19,S20] changed signatures, signer labels and unsigned signer-list edits are refused', (t) => {
  const box = fixture(t);
  succeeds(box, 'signers', 'add', '--key', box.co.publicKey, '--by', 'CO');
  succeeds(box, 'signoff', 'G1', '--by', 'CO');
  const file = join(box.root, '.pullboard/signoffs.jsonl');
  const original = readFileSync(file, 'utf8');

  const tampered = JSON.parse(original);
  tampered.signature = '-----BEGIN SSH SIGNATURE-----\ninvalid\n-----END SSH SIGNATURE-----';
  writeFileSync(file, `${JSON.stringify(tampered)}\n`);
  const badSignature = box.run('spec', 'check');
  assert.notEqual(badSignature.status, 0);
  assert.match(badSignature.stderr, /BAD_SIGNATURE/);

  writeFileSync(file, original);
  for (const [field, value] of Object.entries({ id: 'G2', text: 'a different row', commit: '0'.repeat(40), on: '2000-01-01T00:00:00.000Z', note: 'a different check', firstCommit: '0'.repeat(40) })) {
    const changed = { ...JSON.parse(original), [field]: value };
    writeFileSync(file, `${JSON.stringify(changed)}\n`);
    const refused = box.run('spec', 'check');
    assert.notEqual(refused.status, 0, `${field} is covered by the signature`);
    assert.match(refused.stderr, field === 'firstCommit' ? /BAD_SIGNOFF/u : /BAD_SIGNATURE/u);
  }

  writeFileSync(file, original);
  const foreign = makeKey(join(box.keys, 'foreign'));
  const authorizedRow = JSON.parse(original);
  const message = join(box.dir, 'foreign-message');
  writeFileSync(message, canonical(authorizedRow));
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', foreign.privateKey, '-n', 'pullboard-signoff', message], { cwd: box.root, stdio: 'pipe' });
  authorizedRow.signature = readFileSync(`${message}.sig`, 'utf8').trimEnd();
  writeFileSync(file, `${JSON.stringify(authorizedRow)}\n`);
  const unlistedKey = box.run('spec', 'check');
  assert.notEqual(unlistedKey.status, 0);
  assert.match(unlistedKey.stderr, /BAD_SIGNATURE/);

  writeFileSync(file, original);
  succeeds(box, 'signers', 'add', '--key', box.ab.publicKey, '--by', 'AB');
  const current = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find((record) => record.type === 'row');
  const wrongPrincipal = { ...current };
  wrongPrincipal.by = 'AB';
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse).map((record) => record.type === 'row' ? wrongPrincipal : record);
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  const badBy = box.run('spec', 'check');
  assert.notEqual(badBy.status, 0);
  assert.match(badBy.stderr, /BAD_SIGNATURE/);

  writeFileSync(file, original);
  writeFileSync(join(box.root, '.pullboard/signers'), `${readFileSync(join(box.root, '.pullboard/signers'), 'utf8')}AB namespaces="pullboard-signoff" ${readFileSync(box.ab.publicKey, 'utf8').trim()}\n`);
  const unsignedListChange = box.run('spec', 'check');
  assert.notEqual(unsignedListChange.status, 0);
  assert.match(unsignedListChange.stderr, /UNAUTHORIZED_SIGNERS_CHANGE/);
});

test('[S19] an unknown signer label never verifies against the authorized key', (t) => {
  const box = fixture(t);
  succeeds(box, 'signers', 'add', '--key', box.co.publicKey, '--by', 'CO');
  succeeds(box, 'signoff', 'G1', '--by', 'CO');
  const file = join(box.root, '.pullboard/signoffs.jsonl');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.by = 'ZZ';
  writeFileSync(file, `${JSON.stringify(record)}\n`);
  const check = box.run('spec', 'check');
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /UNLISTED_SIGNER/);
});

test('[S21] signer setup defaults to the configured Git key and email principal and explains the initial commit', (t) => {
  const box = fixture(t);
  const home = join(box.dir, 'git-home');
  const ssh = join(home, '.ssh');
  mkdirSync(ssh, { recursive: true });
  const configured = makeKey(join(ssh, 'custom-signing-key'));
  box.env.HOME = home;
  const globalConfig = join(box.dir, 'global.gitconfig');
  writeFileSync(globalConfig, '[user]\n\temail = global@example.invalid\n\tsigningkey = ~/.ssh/custom-signing-key\n');
  box.env.GIT_CONFIG_GLOBAL = globalConfig;
  box.git('config', '--local', '--unset', 'user.email');
  box.git('config', '--local', '--unset', 'user.signingkey');
  const result = box.run('spec', 'signers', 'add');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /added SSH signer global@example\.invalid/);
  assert.match(result.stdout, /\.pullboard\/first-commit/);
  assert.match(result.stdout, /\.pullboard\/signers\.initial/);
  assert.equal(readFileSync(join(box.root, '.pullboard/first-commit'), 'utf8').trim(), box.git('rev-list', '--max-parents=0', 'HEAD'));
  const allowed = readFileSync(join(box.root, '.pullboard/signers'), 'utf8').trim().split(/\s+/u);
  assert.deepEqual(allowed.slice(0, 4), ['global@example.invalid', 'namespaces="pullboard-signoff"', ...readFileSync(configured.publicKey, 'utf8').trim().split(/\s+/u).slice(0, 2)]);
  const signed = succeeds(box, 'signoff', 'G1');
  assert.match(signed.stdout, /signed 1 rows as global@example\.invalid/);
  assert.match(readFileSync(join(box.root, '.pullboard/signoffs.jsonl'), 'utf8'), /"by":"global@example\.invalid"/);
});

test('[S21] signer setup falls back to ~/.ssh/id_ed25519.pub when Git has no signing key', (t) => {
  const box = fixture(t);
  box.git('config', '--unset', 'user.signingkey');
  const home = join(box.dir, 'home');
  const ssh = join(home, '.ssh');
  mkdirSync(ssh, { recursive: true });
  const fallback = makeKey(join(ssh, 'id_ed25519'));
  box.env.HOME = home;
  const result = box.run('spec', 'signers', 'add');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(readFileSync(join(box.root, '.pullboard/signers'), 'utf8'), new RegExp(readFileSync(fallback.publicKey, 'utf8').trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
});

test('[S5,S18] legacy receipts preserve their shape and cannot meet required SSH signers', (t) => {
  const box = fixture(t);
  succeeds(box, 'signoff', 'G1', '--by', 'CO', '--note', 'legacy evidence');
  succeeds(box, 'signoff', 'G1', '--by', 'AB');
  const file = join(box.root, '.pullboard/signoffs.jsonl');
  const original = readFileSync(file, 'utf8');
  const records = original.trim().split('\n').map(JSON.parse);
  assert.deepEqual(Object.keys(records[0]), ['id', 'by', 'on', 'text', 'note']);
  assert.match(records[0].on, /^\d{4}-\d\d-\d\d$/u);
  assert.equal(existsSync(join(box.root, '.pullboard/signers')), false);
  const missingList = box.run('spec', 'check');
  assert.notEqual(missingList.status, 0);
  assert.match(missingList.stderr, /NO_SIGNERS/u);
  assert.ok(JSON.parse(succeeds(box, 'unmet', '--json').stdout).rows.some((row) => row.id === 'G1'));
  assert.equal(JSON.parse(succeeds(box, 'show', 'G1', '--json').stdout).standing.met.length, 0);
  const page = join(box.dir, 'legacy.html');
  succeeds(box, 'view', '--out', page);
  assert.doesNotMatch(readFileSync(page, 'utf8'), /so-met[^>]*>signed CO/u);
  records.forEach((record) => { record.signature = 'claimed without verification'; });
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  assert.ok(JSON.parse(succeeds(box, 'unmet', '--json').stdout).rows.some((row) => row.id === 'G1'), 'a stored signature flag cannot forge verification');
  writeFileSync(file, original);
  writeFileSync(join(box.root, 'SPEC.md'), SPEC.replace(' | signers: CO,AB', ''));
  assert.equal(JSON.parse(succeeds(box, 'unmet', '--json').stdout).rows.length, 0, 'ordinary legacy rows still accept unsigned receipts');
  const invalid = box.run('spec', 'signoff', 'G1', '--by', 'co@example.invalid');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /BAD_SIGNER/u);
  assert.equal(readFileSync(file, 'utf8'), original, 'legacy signer validation refuses before appending');
  succeeds(box, 'check');
});

test('[S17,S19] an existing empty signer file cannot silently fall back to unsigned sign-offs', (t) => {
  const box = fixture(t);
  const signerFile = join(box.root, '.pullboard/signers');
  mkdirSync(join(box.root, '.pullboard'), { recursive: true });
  writeFileSync(signerFile, '');
  const receiptFile = join(box.root, '.pullboard/signoffs.jsonl');
  for (const args of [['check'], ['signoff', 'G1', '--by', 'CO']]) {
    const result = box.run('spec', ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EMPTY_SIGNERS/u);
    assert.equal(existsSync(receiptFile), false);
  }
  rmSync(signerFile);
  succeeds(box, 'signers', 'add', '--by', 'CO');
  succeeds(box, 'signoff', 'G1', '--by', 'CO');
  const receipt = readFileSync(receiptFile, 'utf8');
  writeFileSync(signerFile, '');
  const check = box.run('spec', 'check');
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /EMPTY_SIGNERS/u);
  assert.equal(readFileSync(receiptFile, 'utf8'), receipt);
});

test('[S20] every signer-list transition is bound to its prior list, hash and authorized key', (t) => {
  const box = fixture(t);
  succeeds(box, 'signers', 'add', '--by', 'CO');
  succeeds(box, 'signers', 'add', '--by', 'AB', '--key', box.ab.publicKey);
  const file = join(box.root, '.pullboard/signoffs.jsonl');
  const original = readFileSync(file, 'utf8');
  const record = JSON.parse(original);
  for (const [field, value] of Object.entries({ previousHash: '0'.repeat(64), previousSigners: 'a different previous list', hash: '0'.repeat(64), firstCommit: '0'.repeat(40), by: 'AB', on: '2000-01-01T00:00:00.000Z', signature: 'invalid SSH signature' })) {
    writeFileSync(file, `${JSON.stringify({ ...record, [field]: value })}\n`);
    const refused = box.run('spec', 'check');
    assert.notEqual(refused.status, 0, `${field} cannot change independently`);
    assert.match(refused.stderr, /UNAUTHORIZED_SIGNERS_CHANGE|BAD_SIGNATURE/u);
  }
  const unauthorized = { ...record, by: 'AB' };
  const message = join(box.dir, 'unauthorized-transition');
  writeFileSync(message, canonical(unauthorized));
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', box.ab.privateKey, '-n', 'pullboard-signoff', message], { stdio: 'pipe' });
  unauthorized.signature = readFileSync(`${message}.sig`, 'utf8').trimEnd();
  writeFileSync(file, `${JSON.stringify(unauthorized)}\n`);
  const refused = box.run('spec', 'check');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /UNAUTHORIZED_SIGNERS_CHANGE/u, 'a new key cannot authorize its own addition');
  writeFileSync(file, original);
  succeeds(box, 'check');
});

test('[S21] setup refuses inline key data and files containing a GPG public key', (t) => {
  const box = fixture(t);
  const publicLine = readFileSync(box.co.publicKey, 'utf8').trim();
  box.git('config', 'user.signingkey', publicLine);
  const inline = box.run('spec', 'signers', 'add');
  assert.notEqual(inline.status, 0);
  assert.match(inline.stderr, /NOT_SSH_KEY_PATH/u);
  const gpg = join(box.keys, 'gpg.pub');
  writeFileSync(gpg, '-----BEGIN PGP PUBLIC KEY BLOCK-----\nsynthetic\n-----END PGP PUBLIC KEY BLOCK-----\n');
  const wrongFormat = box.run('spec', 'signers', 'add', '--key', gpg);
  assert.notEqual(wrongFormat.status, 0);
  assert.match(wrongFormat.stderr, /NOT_SSH_KEY/u);
  assert.equal(existsSync(join(box.root, '.pullboard/signers')), false);
});

test('[S21] setup chooses the oldest root with a hash tie-break and refuses an unanchored shallow clone', (t) => {
  const box = fixture(t);
  box.env.GIT_COMMITTER_DATE = '2000-01-01T00:00:00Z';
  const roots = ['first unrelated root', 'second unrelated root'].map((message) => box.git('commit-tree', 'HEAD^{tree}', '-m', message));
  delete box.env.GIT_COMMITTER_DATE;
  roots.forEach((hash, index) => {
    box.git('branch', `root-${index}`, hash);
    box.git('merge', '--quiet', '--allow-unrelated-histories', `root-${index}`, '-m', 'chore: merge an unrelated root');
  });
  const shallow = join(box.dir, 'unanchored-shallow');
  execFileSync('git', ['clone', '-q', '--depth=1', `file://${box.root}`, shallow], { env: box.env, stdio: 'pipe' });
  const refused = spawnSync(process.execPath, [BIN, 'spec', 'signers', 'add', '--key', box.co.publicKey, '--by', 'CO'], { cwd: shallow, env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /SHALLOW_BEFORE_OPT_IN/u);
  assert.match(refused.stderr, /git fetch --unshallow/u);
  assert.equal(existsSync(join(shallow, '.pullboard/first-commit')), false);
  succeeds(box, 'signers', 'add', '--by', 'CO');
  const anchor = join(box.root, '.pullboard/first-commit');
  assert.equal(readFileSync(anchor, 'utf8').trim(), roots.sort()[0]);
  rmSync(anchor);
  for (const args of [['check'], ['signoff', 'G1', '--by', 'CO']]) {
    const result = box.run('spec', ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NO_FIRST_COMMIT/u);
    assert.equal(existsSync(anchor), false, 'signing and checking never reconstruct a missing anchor');
  }
});
