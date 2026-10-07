/** The public, versioned JSON surface of every pullboard command (A1). */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { join, dirname, resolve, basename, delimiter } from 'node:path';
import { after, test } from 'node:test';
import { resultCommands } from '../src/cli.js';
import { JSON_SHAPES } from '../src/json.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP_DIRS = [];
const covered = new Set();
const coveredRoots = new Set();

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

const SPEC = `# API fixture

## G · Goals
- G1 [approved, must] The fixture keeps its board. | gate: true
`;

/** Quote a literal executable path for the fixture hook's POSIX shim. */
function shellWord(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Make a disposable home and a real repo with isolated git settings. */
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-api-')));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'API Test',
    GIT_AUTHOR_EMAIL: 'api@example.invalid',
    GIT_COMMITTER_NAME: 'API Test',
    GIT_COMMITTER_EMAIL: 'api@example.invalid',
    PULLBOARD_HOME: join(dir, 'home'),
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  return { dir, env, git, run };
}

/** Initialize a real pullboard repo, replace its fixture config, and commit setup files. */
function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const initialized = json(box, repo, 'init');
  const configFile = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, `${JSON.stringify({
    ...config,
    gate: 'true',
    spec: 'SPEC.md',
    practice: 'PRACTICE.md',
    lanes: {
      app: { owns: ['app/'], specs: ['G1'] },
      review: { owns: [] },
    },
    shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  writeFileSync(join(repo, 'PRACTICE.md'), '');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up API fixture');
  return { ...box, repo, initialized };
}

/** Resolve the catalog entry for either a root command or a documented subcommand. */
function shapeFor(command, subcommand) {
  const candidates = [
    ...(subcommand ? [`${command} ${subcommand}`, `${command}.${subcommand}`, `${command}:${subcommand}`] : []),
    command,
  ];
  const key = candidates.find((candidate) => JSON_SHAPES.commands[candidate]);
  assert.ok(key, `JSON_SHAPES.commands must document ${command}${subcommand ? ` ${subcommand}` : ''}`);
  covered.add(key);
  coveredRoots.add(command);
  return JSON_SHAPES.commands[key];
}

/** Match one catalog field to its declared JSON value type. */
function hasType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

/** Check one required-field map from JSON_SHAPES. */
function assertRequiredShape(value, required, label) {
  for (const [field, type] of Object.entries(required ?? {})) {
    assert.ok(Object.hasOwn(value, field), `${label} must include ${field}`);
    assert.ok(hasType(value[field], type), `${label}.${field} must be ${type}`);
  }
}

/** Parse a command's sole JSON document and check its public command shape. */
function json(box, cwd, command, args = [], subcommand) {
  const result = box.run(cwd, command, ...args, '--json');
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}${result.stdout}`);
  assert.equal(result.stderr, '', `${command} --json must keep stderr empty`);
  const document = JSON.parse(result.stdout);
  assert.equal(document.version, 1, `${command} --json has a version 1 envelope`);
  assertRequiredShape(document, shapeFor(command, subcommand).required, command);
  return document;
}

/** Check one refusal document, including the exact public code, message and next step. */
function jsonError(box, cwd, command, args, { status, code, message, next }, subcommand) {
  const result = box.run(cwd, command, ...args, '--json');
  assert.equal(result.status, status, `${command}: ${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '', `${command} refusal must be JSON-only`);
  const document = JSON.parse(result.stdout);
  assert.equal(document.version, 1);
  assertRequiredShape(document, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(document.error, JSON_SHAPES.errorFields, 'error');
  if (subcommand) shapeFor(command, subcommand);
  assert.deepEqual(document.error, { code, message, next });
  return document;
}

/** Assert only that output is a single JSON value with no second document. */
function parseOneDocument(stdout) {
  const document = JSON.parse(stdout);
  assert.equal(document.version, 1);
  return document;
}

test('[A1] command results match the catalog across roots and subcommands', () => {
  const box = project();
  const { repo } = box;
  assert.equal(box.initialized.version, 1);
  assertRequiredShape(box.initialized, shapeFor('init').required, 'init');

  for (const [flag, command] of [['--help', 'help'], ['--version', 'version']]) {
    const output = box.run(repo, flag, '--json');
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stderr, '');
    const document = parseOneDocument(output.stdout);
    assertRequiredShape(document, shapeFor(command).required, command);
  }
  json(box, repo, 'version');
  json(box, repo, 'help');
  json(box, repo, 'lifecycle');
  json(box, repo, 'prompt', ['signoff']);
  json(box, repo, 'hooks');
  json(box, repo, 'whoami');
  json(box, repo, 'lanes');
  json(box, repo, 'resume');
  json(box, repo, 'status');
  json(box, repo, 'doctor');
  const plainStatus = box.run(repo, 'status');
  assert.equal(plainStatus.status, 0, plainStatus.stderr);
  assert.equal(plainStatus.stderr, '');
  assert.match(plainStatus.stdout, /^coordinator: /, 'ordinary text mode remains readable');
  assert.throws(() => JSON.parse(plainStatus.stdout));
  json(box, repo, 'inbox');
  json(box, repo, 'decisions');
  json(box, repo, 'ledger');
  json(box, repo, 'log');
  json(box, repo, 'list');
  json(box, repo, 'gate');

  json(box, repo, 'spec', ['--json']);
  json(box, repo, 'spec', ['check'], 'check');
  json(box, repo, 'spec', ['view', '--out', join(box.dir, 'spec.html')], 'view');
  json(box, repo, 'spec', ['show', 'G1'], 'show');
  json(box, repo, 'spec', ['unmet'], 'unmet');
  mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'test', 'proof.test.js'), "import { test } from 'node:test';\ntest('proof [G1]', () => {});\n");
  box.git(repo, 'add', 'test/proof.test.js');
  box.git(repo, 'commit', '-q', '-m', 'test: cite the fixture');
  const signerKey = join(box.dir, 'signer-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', signerKey], { stdio: 'pipe' });
  box.git(repo, 'config', 'user.signingkey', signerKey);
  json(box, repo, 'spec', ['signers', 'add', '--key', `${signerKey}.pub`, '--by', 'CO'], 'signers');
  box.git(repo, 'add', '.pullboard/signers', '.pullboard/signers.initial', '.pullboard/first-commit');
  box.git(repo, 'commit', '-q', '-m', 'chore: opt into signed sign-offs');
  json(box, repo, 'spec', ['signoff', 'G1', '--by', 'CO'], 'signoff');
  box.git(repo, 'add', '.pullboard/signoffs.jsonl');
  box.git(repo, 'commit', '-q', '-m', 'chore: record the fixture signoff');

  const messageFile = join(box.dir, 'commit-message.txt');
  writeFileSync(messageFile, 'chore: valid fixture\n');
  json(box, repo, 'hook', ['pre-commit'], 'pre-commit');
  json(box, repo, 'hook', ['commit-msg', messageFile], 'commit-msg');
  json(box, repo, 'hook', ['pre-push'], 'pre-push');

  const review = json(box, repo, 'worktree', ['review']);
  const reviewPath = review.path;
  const secondPath = join(box.dir, 'review-two');
  box.git(repo, 'worktree', 'add', '-q', secondPath, '-b', 'review/two');
  json(box, secondPath, 'join', ['review']);

  const added = json(box, repo, 'add', ['coordinator', 'API item', '--specs', 'G1', '--criterion', 'the API item is verified', '--check', 'true']);
  assert.equal(added.item.item_id, 1);
  json(box, repo, 'edit', ['1', '--criterion', 'the edited API item is verified', '--check', 'true']);
  json(box, repo, 'show', ['1']);
  json(box, repo, 'list', ['--all']);
  json(box, repo, 'next');
  json(box, repo, 'claim', ['1']);
  json(box, repo, 'check', ['1']);
  json(box, repo, 'release', ['1']);
  json(box, repo, 'claim', ['1']);
  json(box, repo, 'submit', ['1']);
  json(box, reviewPath, 'next', ['--verify']);
  json(box, reviewPath, 'verify', ['1', 'accept', '--note', 'checked the fixture result']);
  json(box, repo, 'merged', ['1', 'HEAD']);

  json(box, repo, 'add', ['coordinator', 'Done alias item', '--check', 'true']);
  json(box, repo, 'claim', ['2']);
  json(box, repo, 'done', ['2']);
  json(box, repo, 'add', ['coordinator', 'Withdraw item']);
  json(box, repo, 'withdraw', ['3', 'obsolete']);

  json(box, repo, 'add', ['coordinator', 'Refreeze item', '--specs', 'G1']);
  json(box, repo, 'claim', ['4']);
  writeFileSync(join(repo, 'SPEC.md'), SPEC.replace('The fixture keeps its board.', 'The fixture keeps its local board.'));
  json(box, repo, 'refreeze', ['4']);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);

  json(box, repo, 'add', ['coordinator', 'Escalate item', '--route', 'light', '--criterion', 'the item is built', '--check', 'true', '--brief', 'Files:\n- README.md\nChange:\n- keep this fixture\nTest:\n- The item check passes']);
  json(box, repo, 'claim', ['5']);
  json(box, repo, 'escalate', ['5', '--note', 'the first route needs another pass']);
  json(box, repo, 'hold', ['app', '--reason', 'exercise JSON']);
  json(box, repo, 'hold', ['app', '--off']);

  json(box, secondPath, 'shout', ['Please decide', '--decision']);
  json(box, repo, 'decisions');
  json(box, repo, 'pass', ['1', 'The test run is complete']);
  json(box, repo, 'answer', ['2', 'Yes, keep the change', '--as', 'person']);
  json(box, secondPath, 'inbox');
  json(box, repo, 'sweep', ['--run', 'true', '--check', 'true {file}']);

  json(box, reviewPath, 'run', ['--agent', 'true', '--items', '1']);
  json(box, repo, 'forget', ['.']);

  const tour = json(box, repo, 'tour');
  const location = tour.messages.find((line) => line.startsWith('Look around: cd '));
  assert.ok(location, 'tour result keeps its final repo path in messages');
  const tourRepo = /Look around: cd (.+) && pullboard log/.exec(location)?.[1];
  assert.ok(tourRepo && existsSync(tourRepo), 'the reported tour repo exists until the test cleans it up');
  assert.match(basename(dirname(tourRepo)), /^pullboard-tour-/, 'cleanup is confined to the generated tour folder');
  TEMP_DIRS.push(dirname(tourRepo));
});

test('[A1] refusals are one JSON document with exact public error fields', () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  json(box, repo, 'init');
  writeFileSync(join(repo, 'pullboard.json'), `${JSON.stringify({ gate: 'true', lanes: {} }, null, 2)}\n`);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up refusal fixture');

  const noRow = jsonError(box, repo, 'spec', ['show', 'G99'], {
    status: 1,
    code: 'NO_ROW',
    message: 'no row G99 in SPEC.md',
    next: 'Run pullboard help, correct the reported problem, and retry the command.',
  }, 'show');
  assert.equal(noRow.error.code, 'NO_ROW');

  const nothingFree = box.run(repo, 'next', '--json');
  assert.equal(nothingFree.status, 1);
  assert.equal(nothingFree.stderr, '');
  const nextDocument = JSON.parse(nothingFree.stdout);
  assert.equal(nextDocument.version, 1);
  assertRequiredShape(nextDocument, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(nextDocument.error, JSON_SHAPES.errorFields, 'error');
  shapeFor('next');
  assert.deepEqual(nextDocument.error, {
    code: 'NOTHING_FREE',
    message: "no open items in the coordinator lane; lane items are built from each lane's own worktree. To keep looking: pullboard next --wait 9 (minutes; give the command a ten-minute timeout)",
    next: 'To keep looking: pullboard next --wait 9 (minutes; give the command a ten-minute timeout)',
  });

  const unknown = box.run(repo, 'status', '--not-a-real-flag', '--json');
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stderr, '');
  const unknownDocument = JSON.parse(unknown.stdout);
  assert.equal(unknownDocument.version, 1);
  assertRequiredShape(unknownDocument, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(unknownDocument.error, JSON_SHAPES.errorFields, 'error');
  shapeFor('status');
  assert.equal(unknownDocument.error.code, 'USAGE');
  assert.match(unknownDocument.error.message, /Unknown option '--not-a-real-flag'/);
  assert.equal(unknownDocument.error.next, 'run pullboard help');

  const valid = readFileSync(join(repo, 'SPEC.md'), 'utf8');
  writeFileSync(join(repo, 'SPEC.md'), `${valid}\n- G2 [maybe, must] Bad status.\n`);
  const textCheck = box.run(repo, 'spec', 'check');
  assert.equal(textCheck.status, 1);
  const invalid = box.run(repo, 'spec', 'check', '--json');
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr, '');
  const invalidDocument = JSON.parse(invalid.stdout);
  assert.equal(invalidDocument.version, 1);
  assertRequiredShape(invalidDocument, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(invalidDocument.error, JSON_SHAPES.errorFields, 'error');
  shapeFor('spec', 'check');
  assert.equal(invalidDocument.error.code, 'COMMAND_FAILED');
  assert.equal(invalidDocument.error.message, textCheck.stdout.trim());
  assert.equal(invalidDocument.error.next, 'Run pullboard help, correct the reported problem, and retry the command.');
  rmSync(box.dir, { recursive: true, force: true });
});

test('[A1] view flushes one JSON document before shutdown', async (t) => {
  const box = project();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0', '--json'], { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error('view did not flush its JSON result')), 10_000);
    child.stdout.on('data', () => {
      try {
        const document = JSON.parse(stdout);
        clearTimeout(timeout);
        resolveReady(document);
      } catch {
        // The public document is pretty-printed; wait until it is complete.
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
  });
  const document = await ready;
  assert.equal(document.version, 1);
  coveredRoots.add('view');
  assertRequiredShape(document, shapeFor('view').required, 'view');
  child.kill('SIGTERM');
  await closed;
  assert.equal(stderr, '');
  assert.deepEqual(parseOneDocument(stdout), document, 'view does not flush a second document on shutdown');
});

test('[A1] every catalog command and subcommand has a real CLI exercise', () => {
  const source = project();
  const target = project();
  const document = json(source, source.repo, 'export');
  const file = join(source.dir, 'board.json');
  writeFileSync(file, JSON.stringify(document));
  json(source, target.repo, 'import', [file]);
  const humanTarget = project();
  const humanImport = source.run(humanTarget.repo, 'import', file);
  assert.equal(humanImport.status, 0, humanImport.stderr || humanImport.stdout);
  assert.match(humanImport.stdout, /imported version 1 board tables/);

  const missing = Object.keys(JSON_SHAPES.commands).filter((key) => !covered.has(key));
  assert.deepEqual(missing, [], `add real-repo invocations for undocumented coverage gaps: ${missing.join(', ')}`);
  assert.deepEqual([...coveredRoots].sort(), resultCommands(), 'every actual root/factory command has an invocation');
});
