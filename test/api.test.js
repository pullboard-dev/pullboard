/** The public, versioned JSON surface of every pullboard command (A1). */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, startFixtureChild as spawn, runFixtureChild as spawnSync, reportFixtureChildFailure, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { performance } from 'node:perf_hooks';
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
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { join, dirname, resolve, basename, delimiter } from 'node:path';
import { after, test } from 'node:test';
import { resultCommands } from '../src/cli.js';
import { allShouts, closeBoard, EVENT_LOG_VERSION, openBoard } from '../src/board.js';
import { presentationShout, relayPresentation } from '../src/relay-presentation.js';
import { JSON_SHAPES } from '../src/json.js';
import { SSH_SHELL_MARKERS } from '../src/person.js';
import { fetchFresh } from './http-fixture.js';

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

test('[A5] append-only event records expose format version one', () => {
  assert.equal(EVENT_LOG_VERSION, 1);
});

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
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
  };
  for (const marker of SSH_SHELL_MARKERS) delete env[marker];
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  const run = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
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
    practice: 'DOCTRINE.md',
    lanes: {
      app: { owns: ['app/'], specs: ['G1'] },
      review: { owns: [] },
    },
    shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  writeFileSync(join(repo, 'DOCTRINE.md'), '');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up API fixture');
  return { ...box, repo, initialized };
}

/** Read the event-log marker without going through openBoard's version guard. */
function readEventLogVersion(file) {
  const db = new DatabaseSync(file);
  try { return db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('event_log_version')?.meta_value; }
  finally { db.close(); }
}

/** Set a private fixture's event-log marker to model another reader's persisted format. */
function setEventLogVersion(file, version) {
  const db = new DatabaseSync(file);
  try {
    db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
      .run('event_log_version', String(version));
  } finally { db.close(); }
}

test('[A5] board opens upgrade older event logs and refuse future event logs before migration', () => {
  const box = project();
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  assert.equal(readEventLogVersion(file), String(EVENT_LOG_VERSION));

  const future = EVENT_LOG_VERSION + 1;
  setEventLogVersion(file, future);
  const refused = box.run(box.repo, 'status', '--json');
  assert.equal(refused.status, 1, refused.stderr);
  const refusal = JSON.parse(refused.stdout).error;
  assert.equal(refusal.code, 'EVENT_LOG_VERSION');
  assert.match(refusal.message, new RegExp(`event log version ${future}.*version ${EVENT_LOG_VERSION}`));
  assert.match(refusal.next, /upgrade pullboard/i);
  assert.equal(readEventLogVersion(file), String(future), 'a future-format refusal leaves the stored version untouched');

  const partialFile = join(box.dir, 'partial-future.sqlite');
  const partial = new DatabaseSync(partialFile);
  partial.exec("CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL)");
  partial.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run('event_log_version', String(future));
  partial.close();
  assert.throws(() => openBoard(partialFile), { code: 'EVENT_LOG_VERSION' });
  const unchanged = new DatabaseSync(partialFile);
  try {
    assert.equal(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item'").get(), undefined,
      'refusing a future event log rolls back schema creation on an older database');
    assert.equal(unchanged.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('event_log_version').meta_value, String(future));
  } finally { unchanged.close(); }

  setEventLogVersion(file, EVENT_LOG_VERSION - 1);
  const older = box.run(box.repo, 'status', '--json');
  assert.equal(older.status, 0, older.stderr);
  assert.equal(readEventLogVersion(file), String(EVENT_LOG_VERSION), 'opening an older event log upgrades its marker in place');
});

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
  const document = JSON.parse(result.stdout);
  if (command === 'check') {
    assert.equal(result.stderr, `check #${document.id} set by ${document.by}: ${document.check}\n`, 'check attribution is visible before execution while stdout remains one JSON document');
  } else assert.equal(result.stderr, '', `${command} --json must keep stderr empty`);
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
  json(box, repo, 'resources');
  assert.equal(json(box, repo, 'settings').settings.gateSlots, 2);
  assert.equal(json(box, repo, 'settings', ['gateSlots', '1']).settings.gateSlots, 1);
  assert.equal(json(box, repo, 'settings').settings.gateSlots, 1);
  const machineSettings = join(box.env.PULLBOARD_HOME, 'settings.json');
  assert.equal(JSON.parse(readFileSync(machineSettings, 'utf8')).gateSlots, 1);
  assert.equal(existsSync(join(box.env.PULLBOARD_HOME, 'config.json')), false, 'machine settings use the separate settings.json file');
  json(box, repo, 'resume');
  json(box, repo, 'status');
  json(box, repo, 'stats');
  json(box, repo, 'doctor');
  json(box, repo, 'skills', ['--update']);
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
  json(box, repo, 'hook', ['pre-merge-commit'], 'pre-merge-commit');
  json(box, repo, 'hook', ['commit-msg', messageFile], 'commit-msg');
  json(box, repo, 'hook', ['pre-push'], 'pre-push');

  const review = json(box, repo, 'worktree', ['review']);
  const reviewPath = review.path;
  const secondPath = join(box.dir, 'review-two');
  box.git(repo, 'worktree', 'add', '-q', secondPath, '-b', 'review/two');
  json(box, secondPath, 'join', ['review']);

  const added = json(box, repo, 'add', ['coordinator', 'API item', '--specs', 'G1', '--criterion', 'the API item is verified', '--check', 'true']);
  assert.equal(added.item.item_id, 1);
  json(box, repo, 'fact', ['1', 'note', 'API fact']);
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

test('[A1,B21,B27] a lane decision is answered by its agent through CLI JSON', () => {
  const box = project();
  const agent = join(box.dir, 'app-1');
  box.git(box.repo, 'worktree', 'add', '-q', agent, '-b', 'app/one');
  const joined = box.run(agent, 'join', 'app');
  assert.equal(joined.status, 0, joined.stderr);

  const ask = json(box, box.repo, 'shout', ['app', 'Should this endpoint retry?', '--decision']);
  const answer = json(box, agent, 'answer', [String(ask.id), 'Retry once.']);
  assert.equal(answer.answers, ask.id);
  assert.ok(Number.isInteger(answer.id));

  const delivered = json(box, box.repo, 'inbox').shouts.find(({ shout_id }) => shout_id === answer.id);
  assert.ok(delivered, 'the original coordinator receives the lane answer');
  assert.equal(delivered.shout_from, 'app-1');
  assert.equal(delivered.shout_answers, ask.id);
  assert.equal(delivered.shout_text, 'Retry once.');
});

test('[A1,B21,B27] decisions shows an agent its direct and lane asks only', () => {
  const box = project();
  /** Create a real worktree registered to the requested lane. */
  const worktree = (name, lane) => {
    const path = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', path, '-b', `${lane}/${name}`);
    const joined = box.run(path, 'join', lane);
    assert.equal(joined.status, 0, joined.stderr);
    return path;
  };
  const app1 = worktree('app-1', 'app');
  const app2 = worktree('app-2', 'app');
  const review = worktree('review-1', 'review');
  const laneAsk = json(box, box.repo, 'shout', ['app', 'Lane decision?', '--decision']).id;
  const app1Ask = json(box, box.repo, 'shout', ['app-1', 'App one decision?', '--decision']).id;
  const app2Ask = json(box, box.repo, 'shout', ['app-2', 'App two decision?', '--decision']).id;
  const reviewAsk = json(box, box.repo, 'shout', ['review', 'Review decision?', '--decision']).id;
  const coordinatorAsk = json(box, app1, 'shout', ['coordinator', 'Coordinator decision?', '--decision']).id;

  const app1Queue = json(box, app1, 'decisions').decisions.map(({ shout_id }) => shout_id);
  assert.deepEqual(app1Queue, [laneAsk, app1Ask]);
  const app1Text = box.run(app1, 'decisions');
  assert.equal(app1Text.status, 0, app1Text.stderr);
  assert.match(app1Text.stdout, new RegExp(`#${laneAsk}\\b`));
  assert.match(app1Text.stdout, new RegExp(`#${app1Ask}\\b`));
  assert.doesNotMatch(app1Text.stdout, new RegExp(`#(?:${app2Ask}|${reviewAsk}|${coordinatorAsk})\\b`));
  assert.deepEqual(json(box, app2, 'decisions').decisions.map(({ shout_id }) => shout_id), [laneAsk, app2Ask]);
  assert.deepEqual(json(box, review, 'decisions').decisions.map(({ shout_id }) => shout_id), [reviewAsk]);
  const app2Text = box.run(app2, 'decisions');
  assert.equal(app2Text.status, 0, app2Text.stderr);
  assert.match(app2Text.stdout, new RegExp(`#${laneAsk}\\b`));
  assert.match(app2Text.stdout, new RegExp(`#${app2Ask}\\b`));
  const reviewText = box.run(review, 'decisions');
  assert.equal(reviewText.status, 0, reviewText.stderr);
  assert.match(reviewText.stdout, new RegExp(`#${reviewAsk}\\b`));
  assert.doesNotMatch(reviewText.stdout, new RegExp(`#(?:${laneAsk}|${app1Ask}|${app2Ask}|${coordinatorAsk})\\b`));

  json(box, app2, 'answer', [String(laneAsk), 'Lane answered.']);
  assert.deepEqual(json(box, app1, 'decisions').decisions.map(({ shout_id }) => shout_id), [app1Ask]);
  const answeredText = box.run(app2, 'decisions');
  assert.equal(answeredText.status, 0, answeredText.stderr);
  assert.match(answeredText.stdout, new RegExp(`#${app2Ask}\\b`));
  assert.doesNotMatch(answeredText.stdout, new RegExp(`#${laneAsk}\\b`));
  assert.deepEqual(json(box, box.repo, 'decisions').decisions.map(({ shout_id }) => shout_id), [coordinatorAsk]);
  const passedAsk = json(box, app1, 'shout', ['coordinator', 'Please decide this.', '--decision']).id;
  const pass = json(box, box.repo, 'pass', [String(passedAsk), 'the person should decide']);
  assert.deepEqual(json(box, box.repo, 'decisions', ['--as', 'person']).decisions.map(({ shout_id }) => shout_id), [pass.id]);
  jsonError(box, app1, 'decisions', ['--as', 'person'], {
    status: 1,
    code: 'B26_PERSON_ANSWER',
    message: 'only the main checkout can act as the person; ask your coordinator to answer or pass this decision',
    next: 'ask your coordinator to answer or pass this decision',
  });
  jsonError(box, app1, 'answer', [String(app2Ask), 'No'], {
    status: 1,
    code: 'NOT_YOUR_DECISION',
    message: `shout #${app2Ask} is addressed to app-2, not your app lane (agent app-1)`,
    next: 'Run pullboard help, correct the reported problem, and retry the command.',
  });
  const coordinatorText = box.run(box.repo, 'decisions');
  assert.equal(coordinatorText.status, 0, coordinatorText.stderr);
  assert.match(coordinatorText.stdout, new RegExp(`#${coordinatorAsk}\\b`));
  assert.doesNotMatch(coordinatorText.stdout, new RegExp(`#(?:${app1Ask}|${app2Ask}|${reviewAsk})\\b`));
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

  const unknownCommand = box.run(repo, 'cliam', '--json');
  assert.equal(unknownCommand.status, 2);
  assert.equal(unknownCommand.stderr, '');
  const unknownCommandDocument = JSON.parse(unknownCommand.stdout);
  assert.equal(unknownCommandDocument.version, 1);
  assertRequiredShape(unknownCommandDocument, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(unknownCommandDocument.error, JSON_SHAPES.errorFields, 'error');
  assert.equal(unknownCommandDocument.error.code, 'USAGE');
  assert.match(unknownCommandDocument.error.message, /no command "cliam"; closest match is "claim"/);
  assert.match(unknownCommandDocument.error.next, /pullboard help --all/);

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

test('[A1] long-running servers flush one JSON document before shutdown', async (t) => {
  for (const command of ['view', 'serve']) {
    const box = project();
    t.after(() => rmSync(box.dir, { recursive: true, force: true }));
    const args = [BIN, command, ...(command === 'view' ? ['--no-open'] : []), '--port', '0', '--json'];
    const startedAt = performance.now();
    const child = spawn(process.execPath, args, { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      let settled = false;
      const failStartup = (detail, status = child.exitCode, signal = child.signalCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectReady(new Error(reportFixtureChildFailure({ command: process.execPath, args, status, signal,
          elapsedMs: performance.now() - startedAt, stderr, env: box.env, detail })));
      };
      const timeout = setTimeout(() => failStartup('server readiness deadline (10000ms) expired'), 10_000);
      child.stdout.on('data', () => {
        try {
          const document = JSON.parse(stdout);
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolveReady(document);
        } catch {
          // The public document is pretty-printed; wait until it is complete.
        }
      });
      child.once('error', (error) => {
        failStartup(error.message, null, null);
      });
      child.once('close', (code, signal) => failStartup('server exited before flushing its JSON result', code, signal));
    });
    const document = await ready;
    assert.equal(document.version, 1);
    coveredRoots.add(command);
    assertRequiredShape(document, shapeFor(command).required, command);
    child.kill('SIGTERM');
    await closed;
    assert.equal(stderr, '');
    assert.deepEqual(parseOneDocument(stdout), document, `${command} does not flush a second document on shutdown`);
  }
});
test('[A1,A10] view exports a static folder through its JSON variant', () => {
  const box = project();
  const item = json(box, box.repo, 'add', ['app', 'Snapshot item', '--specs', 'G1']).item;
  const output = join(box.dir, 'snapshot folder');
  const result = json(box, box.repo, 'view', ['--export', output], 'export');
  assert.equal(result.path, output);
  assert.equal(result.url, undefined);
  assert.equal(result.port, undefined);
  assert.ok(existsSync(join(output, 'index.html')));
  assert.ok(existsSync(join(output, 'view.css')));
  const listing = JSON.parse(readFileSync(join(output, 'api/v1/boards.json'), 'utf8'));
  assert.equal(listing.version, 1);
  assert.equal(listing.boards.length, 1);
  const id = listing.boards[0].id;
  const state = JSON.parse(readFileSync(join(output, 'api/v1/boards', id, 'state.json'), 'utf8'));
  const events = JSON.parse(readFileSync(join(output, 'api/v1/boards', id, 'events.json'), 'utf8'));
  assert.equal(state.version, 1);
  assert.equal(state.state.board, id);
  assert.equal(state.eventLogVersion, EVENT_LOG_VERSION);
  assert.equal(state.state.root, basename(box.repo));
  assert.equal(state.state.items[0].id, item.item_id);
  assert.equal(events.version, 1);
  assert.equal(events.eventLogVersion, EVENT_LOG_VERSION);
  assert.ok(events.events.some((event) => event.event_kind === 'add' && event.item_id === item.item_id));
  assert.deepEqual(events.events.map((event) => event.event_id), events.events.map((event) => event.event_id).sort((a, b) => a - b));
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

  json(source, source.repo, 'relay');
  json(source, source.repo, 'relay', ['off']);
  const catalog = json(source, source.repo, 'add', ['app', 'Catalog item', '--criterion', 'catalog coverage'], 'add').item;
  json(source, source.repo, 'roadmap');
  json(source, source.repo, 'milestone', ['add', 'Catalog', '--items', String(catalog.item_id)], 'add');
  json(source, source.repo, 'milestone', ['items', 'Catalog', '--remove', String(catalog.item_id)], 'items');
  json(source, source.repo, 'milestone', ['items', 'Catalog', '--add', String(catalog.item_id)], 'items');
  json(source, source.repo, 'milestone', ['add', 'Later'], 'add');
  json(source, source.repo, 'milestone', ['move', 'Later', '--before', 'Catalog'], 'move');
  json(source, source.repo, 'milestone', ['edit', 'Catalog', '--name', 'Release', '--note', 'Catalog coverage'], 'edit');
  json(source, source.repo, 'milestone', ['remove', 'Later'], 'remove');
  json(source, source.repo, 'milestone', ['remove', 'Release'], 'remove');
  json(source, source.repo, 'spec', ['approve', 'G1'], 'approve');
  json(source, source.repo, 'spec', ['decline', 'G1', '--reason', 'Catalog decline'], 'decline');
  json(source, source.repo, 'spec', ['apply'], 'apply');
  /** Exercise the agent-only takeover with a private explicit session, leaving later terminal calls markerless. */
  const sessionSource = { ...source, run: (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env: { ...source.env, CODEX_SESSION_ID: 'api-catalog-session' }, encoding: 'utf8' }) };
  json(sessionSource, source.repo, 'takeover');
  const missing = Object.keys(JSON_SHAPES.commands).filter((key) => !covered.has(key));
  assert.deepEqual(missing, [], `add real-repo invocations for undocumented coverage gaps: ${missing.join(', ')}`);
  assert.deepEqual([...coveredRoots].sort(), resultCommands(), 'every actual root/factory command has an invocation');
});

test('[N26,A2] roadmap text, JSON and API state follow live local and registered repo items', async (t) => {
  const box = project();
  const foreign = project();
  const foreignConfigFile = join(foreign.repo, 'pullboard.json');
  const foreignConfig = JSON.parse(readFileSync(foreignConfigFile, 'utf8'));
  foreignConfig.name = 'foreign';
  writeFileSync(foreignConfigFile, `${JSON.stringify(foreignConfig, null, 2)}\n`);
  const registryFile = join(box.env.PULLBOARD_HOME, 'projects.json');
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  registry.projects.push({ root: foreign.repo, name: 'foreign', project: '', added: '2026-10-08T00:00:00.000Z' });
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);

  const addArgs = (title) => [
    'app', title, '--route', 'light', '--criterion', 'roadmap item', '--check', 'true',
    '--brief', 'Files:\n- app/roadmap.js\nChange: track this work\nTest: inspect its status',
  ];
  const localItem = json(box, box.repo, 'add', addArgs('Local release'), 'add').item;
  const externalItem = json(foreign, foreign.repo, 'add', addArgs('External follow-up'), 'add').item;
  const worktree = json(box, box.repo, 'worktree', ['app', '--route', 'light'], 'worktree');

  json(box, box.repo, 'milestone', ['add', 'Delivery', '--note', 'Ship the release', '--items', `${localItem.item_id},foreign#${externalItem.item_id}`], 'add');
  json(box, box.repo, 'milestone', ['add', 'Aftercare'], 'add');
  json(box, box.repo, 'milestone', ['move', 'Aftercare', '--before', 'Delivery'], 'move');
  jsonError(box, worktree.path, 'milestone', ['add', 'Forbidden'], {
    status: 1,
    code: 'COORDINATOR_ONLY',
    message: 'only the coordinator changes milestones; ask your coordinator to update the roadmap',
    next: 'ask your coordinator to update the roadmap',
  }, 'add');
  const claim = box.run(worktree.path, 'claim', String(localItem.item_id), '--json');
  assert.equal(claim.status, 0, claim.stderr || claim.stdout);

  const textRoadmap = box.run(box.repo, 'roadmap');
  assert.equal(textRoadmap.status, 0, textRoadmap.stderr);
  assert.ok(textRoadmap.stdout.indexOf('Aftercare: 0/0 done') < textRoadmap.stdout.indexOf('Delivery: 0/2 done'));
  assert.match(textRoadmap.stdout, /Ship the release/);
  assert.match(textRoadmap.stdout, new RegExp(`#${localItem.item_id} Local release — claimed`));
  assert.match(textRoadmap.stdout, new RegExp(`foreign#${externalItem.item_id} External follow-up — open`));

  const document = json(box, box.repo, 'roadmap');
  assert.deepEqual(document.milestones.map(({ name }) => name), ['Aftercare', 'Delivery']);
  assert.deepEqual(document.milestones[1].items.map(({ status }) => status), ['claimed', 'open']);
  const api = await startApi(t, box);
  const listing = await (await apiFetch(api, '/api/v1/boards')).json();
  const current = listing.boards.find((candidate) => candidate.root === box.repo);
  const response = await apiFetch(api, `/api/v1/boards/${current.id}/state`);
  const state = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(state.state.milestones, document.milestones);
});

/** Start the real local API server and stop it when its test finishes. */
async function startApi(t, box) {
  const args = [BIN, 'serve', '--port', '0', '--json'];
  const startedAt = performance.now();
  const child = spawn(process.execPath, args, { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) {
      let timeout;
      await Promise.race([closed, new Promise((resolveDone) => { timeout = setTimeout(resolveDone, 10_000); })]);
      clearTimeout(timeout);
    }
  });
  const document = await new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const failStartup = (detail, status = child.exitCode, signal = child.signalCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectReady(new Error(reportFixtureChildFailure({ command: process.execPath, args, status, signal,
        elapsedMs: performance.now() - startedAt, stderr, env: box.env, detail })));
    };
    const timeout = setTimeout(() => failStartup('serve readiness deadline (10000ms) expired'), 10_000);
    const check = () => {
      try {
        const parsed = JSON.parse(stdout);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolveReady(parsed);
      } catch {
        // The startup envelope is pretty-printed across several chunks.
      }
    };
    child.stdout.on('data', check);
    child.once('error', (error) => failStartup(error.message, null, null));
    child.once('close', (code, signal) => failStartup('serve exited before readiness', code, signal));
    child.once('close', (code) => {
      if (code !== 0) { clearTimeout(timeout); rejectReady(new Error(`serve exited ${code}: ${stderr}`)); }
    });
  });
  assert.equal(document.version, 1);
  const parsed = new URL(document.url);
  const secret = parsed.searchParams.get('k');
  assert.ok(secret, 'serve startup exposes its per-session secret in its private URL');
  return { child, document, origin: parsed.origin, secret, stderr: () => stderr };
}

/** Send one bounded HTTP request to the fixture API on its own connection, authenticating by header unless overridden. */
function apiFetch(api, path, options = {}) {
  const { noSecret = false, ...requestOptions } = options;
  const headers = { ...(noSecret ? {} : { 'x-pullboard-key': api.secret }), ...requestOptions.headers };
  return fetchFresh(new URL(path, api.origin), { ...requestOptions, headers, signal: requestOptions.signal ?? AbortSignal.timeout(10_000) });
}

/** Parse and validate a versioned API refusal. */
async function apiError(response, status) {
  assert.equal(response.status, status);
  const document = await response.json();
  assertRequiredShape(document, JSON_SHAPES.error.required, 'HTTP error envelope');
  assertRequiredShape(document.error, JSON_SHAPES.errorFields, 'HTTP error');
  return document.error;
}

/** Read exactly the next non-comment server-sent event, preserving partial frames across chunks. */
async function nextSseEvent(reader, pending = { text: '' }) {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = pending.text.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = pending.text.slice(0, boundary);
      pending.text = pending.text.slice(boundary + 2);
      const id = /^id: (.+)$/m.exec(frame)?.[1];
      const data = [...frame.matchAll(/^data: (.+)$/gm)].map((match) => match[1]).join('\n');
      if (id !== undefined && data) return { id, document: JSON.parse(data) };
      continue;
    }
    const { done, value } = await reader.read();
    assert.equal(done, false, 'the live event stream remains open');
    pending.text += decoder.decode(value, { stream: true });
  }
}

test('[N38] local API and sealed presentation resolve shouts beyond recent state, with complete export history', async (t) => {
  const box = project();
  const api = await startApi(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const boardId = boards.boards.find((candidate) => candidate.root === box.repo).id;
  const boardPath = `/api/v1/boards/${boardId}`;
  const decision = json(box, box.repo, 'shout', ['person', 'An old decision', '--decision']);
  json(box, box.repo, 'answer', [String(decision.id), 'Approved', '--as', 'person']);
  const openDecision = json(box, box.repo, 'shout', ['person', 'An old open decision', '--decision']);
  for (let index = 0; index < 40; index += 1) json(box, box.repo, 'shout', ['app', `recent message ${index}`]);

  const state = await (await apiFetch(api, `${boardPath}/state`)).json();
  assert.equal(state.state.shouts.length, 40);
  assert.ok(!state.state.shouts.some((shout) => shout.shout_id === decision.id), 'the addressed shout is older than the existing recent-40 state');
  assert.ok(!state.state.shouts.some((shout) => shout.shout_id === openDecision.id));
  const direct = await apiFetch(api, `${boardPath}/shouts/${decision.id}`);
  assert.equal(direct.status, 200);
  const directDocument = await direct.json();
  assertRequiredShape(directDocument, JSON_SHAPES.http.shout.required, 'shout response');
  assert.equal(directDocument.version, JSON_SHAPES.version);
  const oldShout = directDocument.shout;
  assert.equal(oldShout.shout_id, decision.id);
  assert.equal(oldShout.shout_from, 'coordinator');
  assert.equal(oldShout.shout_to, 'person');
  assert.equal(oldShout.shout_text, 'An old decision');
  assert.equal(oldShout.shout_decision, 1);
  assert.equal(oldShout.decision_state, 'answered');
  assert.equal(oldShout.decision_answer.shout_text, 'Approved');
  assert.ok(oldShout.shout_at);
  const open = await (await apiFetch(api, `${boardPath}/shouts/${openDecision.id}`)).json();
  assert.equal(open.shout.decision_state, 'open');
  assert.equal(open.shout.decision_answer, null);

  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let history;
  try { history = allShouts(board); } finally { closeBoard(board); }
  assert.equal(history.length, 43);
  const answer = history.find((shout) => shout.shout_answers === decision.id);
  assert.ok(answer, 'the complete read retains the decision reply relationship');
  assert.equal(answer.shout_text, 'Approved');
  const presentation = relayPresentation(box.repo);
  assert.throws(() => presentationShout({ state: presentation.state }, decision.id), { code: 'SHOUT_NOT_AVAILABLE' },
    'older snapshots without complete history refuse the capability clearly');
  assert.equal(presentation.shouts.length, 43);
  assert.equal(presentation.shouts[0].shout_id, decision.id);
  assert.equal(presentation.shouts[0].shout_text, 'An old decision');
  assert.equal(presentation.state.shouts.length, 40, 'sealed presentation keeps the state window bounded separately');

  const linkFile = join(box.repo, '.git', 'pullboard', 'relay.json');
  writeFileSync(linkFile, JSON.stringify({ version: 1, mode: 'ordered', board: boardId,
    url: 'https://app.pullboard.dev', repository: 'fixture/repository', token: 'ps_' + 'a'.repeat(43), sequence: 0, cursor: 0 }) + '\n', { mode: 0o600 });
  const throughRelayPresentation = await apiFetch(api, `${boardPath}/shouts/${decision.id}`);
  const relayDocument = await throughRelayPresentation.json();
  assert.equal(throughRelayPresentation.status, 200, JSON.stringify(relayDocument));
  assert.deepEqual(relayDocument.shout, JSON.parse(JSON.stringify(oldShout)));

  const missing = await apiFetch(api, `${boardPath}/shouts/999999`);
  assert.equal((await apiError(missing, 404)).code, 'NO_SHOUT');
  const malformed = await apiFetch(api, `${boardPath}/shouts/0`);
  assert.equal((await apiError(malformed, 400)).code, 'BAD_REQUEST');
  const malformedText = await apiFetch(api, `${boardPath}/shouts/nope`);
  assert.equal((await apiError(malformedText, 400)).code, 'BAD_REQUEST');
  await apiError(await apiFetch(api, `${boardPath}/shouts/${decision.id}`, { noSecret: true }), 401);
  await apiError(await apiFetch(api, `${boardPath}/shouts/${decision.id}`, { headers: { 'x-pullboard-key': 'wrong-session-secret' } }), 401);
  assert.equal((await (await apiFetch(api, `${boardPath}/state`)).json()).state.shouts.length, 40,
    'addressed reads and refusals do not change the recent-40 projection');
});

test('[A2] local HTTP v1 versions state and moves, authenticates, and preserves CLI refusals', async (t) => {
  const box = project();
  const api = await startApi(t, box);

  const boardsResponse = await apiFetch(api, '/api/v1/boards');
  assert.equal(boardsResponse.status, 200);
  const boardsDocument = await boardsResponse.json();
  assertRequiredShape(boardsDocument, JSON_SHAPES.http.boards.required, 'boards response');
  const board = boardsDocument.boards.find((candidate) => candidate.root === box.repo);
  assert.ok(board?.id);
  const boardPath = `/api/v1/boards/${board.id}`;

  await apiError(await apiFetch(api, '/api/v1/boards', { noSecret: true }), 401);
  await apiError(await apiFetch(api, '/api/v1/boards', { headers: { 'x-pullboard-key': 'wrong-session-secret' } }), 401);
  const unknown = await apiError(await apiFetch(api, `/api/v1/boards/${'0'.repeat(32)}/state`), 404);
  assert.equal(unknown.code, 'NO_BOARD');

  const stateResponse = await apiFetch(api, `${boardPath}/state`);
  assert.equal(stateResponse.status, 200);
  const stateDocument = await stateResponse.json();
  assertRequiredShape(stateDocument, JSON_SHAPES.http.state.required, 'state response');
  assert.equal(stateDocument.version, 1);
  assert.equal(stateDocument.eventLogVersion, EVENT_LOG_VERSION);
  const eventsResponse = await apiFetch(api, `${boardPath}/events?after=0`);
  assert.equal(eventsResponse.status, 200);
  const eventsDocument = await eventsResponse.json();
  assertRequiredShape(eventsDocument, JSON_SHAPES.http.events.required, 'events response');
  assert.equal(eventsDocument.version, 1);
  assert.equal(eventsDocument.eventLogVersion, EVENT_LOG_VERSION);

  const malformed = await apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
  assert.equal((await apiError(malformed, 400)).code, 'BAD_REQUEST');
  const oversized = await apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'x'.repeat(100_001) } }) });
  assert.equal((await apiError(oversized, 400)).code, 'BAD_REQUEST');
  const unknownVerb = await apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'pretend', args: {} }) });
  assert.equal((await apiError(unknownVerb, 400)).code, 'BAD_REQUEST');
  const unknownArgument = await apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Ignored', extra: true } }) });
  assert.equal((await apiError(unknownArgument, 400)).code, 'BAD_REQUEST');

  const cliRefusal = JSON.parse(box.run(box.repo, 'claim', '999', '--json').stdout).error;
  const refusalResponse = await apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'claim', item: 999, args: {} }) });
  assert.deepEqual(await apiError(refusalResponse, 409), cliRefusal, 'HTTP move refusals preserve the CLI code, message and next step');

  const noWork = JSON.parse(box.run(box.repo, 'next', '--json').stdout).error;
  const nextResponse = await apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'next', args: {} }) });
  assert.equal(noWork.code, 'NOTHING_FREE');
  assert.deepEqual(await apiError(nextResponse, 409), noWork, 'next keeps the CLI no-work refusal and its polling guidance');

  const verifierRefusal = JSON.parse(box.run(box.repo, 'verify', '999', 'accept', '--as', 'coordinator', '--note', 'checked the API', '--json').stdout).error;
  const verifyResponse = await apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'verify', item: 999, args: { decision: 'accept', as: 'coordinator', note: 'checked the API' } }) });
  assert.deepEqual(await apiError(verifyResponse, 409), verifierRefusal, 'coordinator verification can explicitly assert the same identity as the CLI');

  const movedResponse = await apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: '--help' } }) });
  assert.equal(movedResponse.status, 200);
  const moved = await movedResponse.json();
  assertRequiredShape(moved, JSON_SHAPES.http.move.required, 'move response');
  assert.equal(moved.result.item.item_title, '--help', 'positional titles beginning with a dash stay literal');
  assert.equal(moved.event.event_kind, 'add');
  assert.equal(moved.event.event_id, eventsDocument.events.at(-1)?.event_id + 1);
  assert.equal(api.stderr(), '');
});

test('[A2] moves run as the named worktree agent and requests stay visible until answered', async (t) => {
  const box = project();
  const app = join(box.dir, 'app-1');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'app/one', app);
  assert.equal(box.run(app, 'join', 'app').status, 0);
  const api = await startApi(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const board = boards.boards.find((candidate) => candidate.root === box.repo);
  const path = `/api/v1/boards/${board.id}`;

  const added = await (await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Agent work' } }) })).json();
  const claimedResponse = await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'next', args: {}, agent: 'app-1' }) });
  assert.equal(claimedResponse.status, 200);
  const claimed = await claimedResponse.json();
  assert.equal(claimed.event.event_by, 'app-1');
  assert.equal(claimed.event.event_kind, 'claim');
  assert.equal(claimed.result.item.item_id, added.result.item.item_id);

  const renewedResponse = await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'next', args: {}, agent: 'app-1' }) });
  assert.equal(renewedResponse.status, 200);
  const renewed = await renewedResponse.json();
  assert.equal(renewed.result.held, true);
  assert.equal(renewed.event.event_kind, 'renew');
  assert.ok(renewed.event.event_id > claimed.event.event_id);
  assert.equal(renewed.result.item.item_id, claimed.result.item.item_id);

  const escalatedResponse = await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'escalate', item: added.result.item.item_id, args: { note: 'Two attempts failed' }, agent: 'app-1' }) });
  assert.equal(escalatedResponse.status, 200);
  const escalated = await escalatedResponse.json();
  assert.equal(escalated.event.event_kind, 'escalate', 'a move returns its own event even when it also sends a coordinator shout');
  const afterEscalation = (await (await apiFetch(api, `${path}/events?after=${renewed.event.event_id}`)).json()).events;
  assert.deepEqual(afterEscalation.map((event) => event.event_kind), ['escalate', 'shout']);
  assert.equal(afterEscalation[0].event_id, escalated.event.event_id);

  const requestResponse = await apiFetch(api, `${path}/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Approve the API row' }) });
  assert.equal(requestResponse.status, 200);
  const requested = await requestResponse.json();
  assertRequiredShape(requested, JSON_SHAPES.http.request.required, 'request response');
  const requestId = requested.result.id;
  assert.equal(requested.event.event_by, 'person');
  const state = (await (await apiFetch(api, `${path}/state`)).json()).state;
  assert.deepEqual(state.requests.map((entry) => entry.shout_id), [requestId]);
  assert.ok(!state.decisions.some((entry) => entry.shout_id === requestId), 'person requests are not open decisions');
  const inbox = json(box, box.repo, 'inbox');
  assert.equal(inbox.shouts[0].shout_id, requestId, 'coordinator inbox places the request first');
  const resumed = json(box, box.repo, 'resume');
  assert.equal(resumed.requests[0].shout_id, requestId, 'coordinator resume places the request first');

  const answerResponse = await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'answer', item: requestId, args: { text: 'done' } }) });
  assert.equal(answerResponse.status, 200);
  const answered = await answerResponse.json();
  assert.equal(answered.event.event_kind, 'answer');
  assert.equal(answered.event.event_by, 'coordinator');
  assert.deepEqual((await (await apiFetch(api, `${path}/state`)).json()).state.requests, []);
});

test('[A2,B25,B26,B27] HTTP decisions preserve routing, passing and explicit person answers', async (t) => {
  const box = project();
  const app = join(box.dir, 'app-1');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'app/one', app);
  assert.equal(box.run(app, 'join', 'app').status, 0);
  const api = await startApi(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const board = boards.boards.find((candidate) => candidate.root === box.repo);
  const path = `/api/v1/boards/${board.id}`;
  /** Send a real HTTP move while retaining the caller and CLI argument boundaries. */
  const move = (verb, args, item, agent = 'coordinator') => apiFetch(api, `${path}/moves`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb, args, ...(item === undefined ? {} : { item }), agent }),
  });

  const askResponse = await move('shout', { text: 'May this ship?', decision: true }, undefined, 'app-1');
  assert.equal(askResponse.status, 200);
  const ask = await askResponse.json();
  assert.equal(ask.version, 1);
  assert.equal(ask.event.event_kind, 'shout');
  assert.equal(ask.event.event_by, 'app-1');
  assert.equal(JSON.parse(ask.event.event_detail).to, 'coordinator');

  const notCoordinator = JSON.parse(box.run(app, 'pass', String(ask.result.id), 'Needs the person', '--json').stdout).error;
  assert.deepEqual(await apiError(await move('pass', { note: 'Needs the person' }, ask.result.id, 'app-1'), 409), notCoordinator);

  const passResponse = await move('pass', { note: 'Needs the person' }, ask.result.id);
  assert.equal(passResponse.status, 200);
  const passed = await passResponse.json();
  assert.equal(passed.version, 1);
  assert.equal(passed.event.event_kind, 'pass');
  assert.equal(JSON.parse(passed.event.event_detail).to, 'person');

  const personRequired = JSON.parse(box.run(box.repo, 'answer', String(passed.result.id), 'Approved', '--json').stdout).error;
  assert.equal(personRequired.code, 'B26_PERSON_ANSWER');
  assert.deepEqual(await apiError(await move('answer', { text: 'Approved' }, passed.result.id), 409), personRequired);
  const answerResponse = await move('answer', { text: 'Approved', as: 'person' }, passed.result.id);
  assert.equal(answerResponse.status, 200);
  const answered = await answerResponse.json();
  assert.equal(answered.version, 1);
  assert.equal(answered.event.event_by, 'person');
  assert.equal(answered.event.event_kind, 'answer');
  const replies = json(box, app, 'inbox').shouts;
  assert.ok(replies.some((entry) => entry.shout_answers === ask.result.id && entry.shout_from === 'person' && entry.shout_text.includes('Approved')));
  assert.deepEqual((await (await apiFetch(api, `${path}/state`)).json()).state.decisions, []);
});

test('[A2] SSE delivers a live move and resumes after Last-Event-ID without replay', async (t) => {
  const box = project();
  const api = await startApi(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const board = boards.boards.find((candidate) => candidate.root === box.repo);
  const path = `/api/v1/boards/${board.id}`;
  const backlog = await (await apiFetch(api, `${path}/events?after=0`)).json();
  const cursor = backlog.events.at(-1)?.event_id ?? 0;
  const eventUrl = `${path}/events?after=${cursor}`;

  const firstResponse = await apiFetch(api, eventUrl, { headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(10_000) });
  assert.equal(firstResponse.status, 200);
  assert.match(firstResponse.headers.get('content-type'), /text\/event-stream/);
  const firstReader = firstResponse.body.getReader();
  const firstPending = { text: '' };
  let firstEvent;
  try {
    const firstMove = await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Live one' } }) });
    assert.equal(firstMove.status, 200);
    const expectedFirst = await firstMove.json();
    firstEvent = await nextSseEvent(firstReader, firstPending);
    assertRequiredShape(firstEvent.document, JSON_SHAPES.http.stream.required, 'SSE event');
    assert.equal(firstEvent.document.version, 1);
    assert.equal(firstEvent.id, String(expectedFirst.event.event_id));
    assert.deepEqual(firstEvent.document.event, expectedFirst.event);
  } finally {
    await firstReader.cancel();
  }

  const reconnect = await apiFetch(api, `${path}/events`, {
    headers: { accept: 'text/event-stream', 'last-event-id': firstEvent.id },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(reconnect.status, 200);
  const reader = reconnect.body.getReader();
  try {
    const secondMove = await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Live two' } }) });
    assert.equal(secondMove.status, 200);
    const expectedSecond = await secondMove.json();
    const second = await nextSseEvent(reader);
    assert.equal(second.id, String(expectedSecond.event.event_id));
    assert.ok(Number(second.id) > Number(firstEvent.id), 'the reconnect resumed after the delivered event without replay');
    assert.equal(second.document.event.event_kind, 'add');
    assert.notEqual(second.id, firstEvent.id);
  } finally {
    await reader.cancel();
  }
});

test('[A5,A6] doctor diagnoses future event logs read-only and accepts the current marker', () => {
  const box = project();
  const added = json(box, box.repo, 'add', ['app', 'Version fixture', '--specs', 'G1']);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  assert.ok(added.item.item_id);
  assert.equal(readEventLogVersion(file), String(EVENT_LOG_VERSION));
  const beforeCurrent = readFileSync(file);
  const current = box.run(box.repo, 'doctor', '--json');
  assert.equal(current.status, 0, current.stderr || current.stdout);
  assert.equal(current.stderr, '');
  assert.deepEqual(JSON.parse(current.stdout).problems, [], 'the current event-log version is healthy');
  assert.deepEqual(readFileSync(file), beforeCurrent, 'doctor leaves a current board byte-for-byte unchanged');

  setEventLogVersion(file, EVENT_LOG_VERSION + 1);
  const eventsDb = new DatabaseSync(file);
  let events;
  try { events = eventsDb.prepare('SELECT COUNT(*) AS count FROM event').get().count; }
  finally { eventsDb.close(); }
  assert.ok(events > 0, 'the fixture has real events before modeling the future version');
  const futureBytes = readFileSync(file);
  const refused = box.run(box.repo, 'doctor', '--json');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.equal(refused.stderr, '', 'doctor returns a JSON finding');
  const problems = JSON.parse(refused.stdout).problems;
  const problem = problems.find((entry) => entry.code === 'EVENT_LOG_VERSION');
  assert.ok(problem, refused.stdout);
  assert.match(problem.message, new RegExp(`event log version ${EVENT_LOG_VERSION + 1}.*version ${EVENT_LOG_VERSION}`));
  assert.match(problem.next, /upgrade pullboard/i);
  assert.deepEqual(readFileSync(file), futureBytes, 'the read-only diagnosis preserves the complete board file');
  assert.equal(readEventLogVersion(file), String(EVENT_LOG_VERSION + 1), 'doctor does not silently upgrade the marker');
});

test('[A5] view export preserves the typed future-version refusal without creating output', () => {
  const box = project();
  const added = json(box, box.repo, 'add', ['app', 'Export version fixture', '--specs', 'G1']);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  assert.ok(added.item.item_id);
  setEventLogVersion(file, EVENT_LOG_VERSION + 1);
  const eventsDb = new DatabaseSync(file);
  let events;
  try { events = eventsDb.prepare('SELECT COUNT(*) AS count FROM event').get().count; }
  finally { eventsDb.close(); }
  assert.ok(events > 0, 'the fixture has real events before export refuses');
  const before = readFileSync(file);
  const output = join(box.dir, 'future-version-export');
  assert.equal(existsSync(output), false);

  const refused = box.run(box.repo, 'view', '--export', output, '--json');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.equal(refused.stderr, '', 'view export returns a JSON refusal');
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'EVENT_LOG_VERSION', refused.stdout);
  assert.match(error.message, new RegExp(`event log version ${EVENT_LOG_VERSION + 1}.*version ${EVENT_LOG_VERSION}`));
  assert.match(error.next, /upgrade pullboard/i);
  assert.equal(existsSync(output), false, 'refused export creates no output directory or files');
  assert.deepEqual(readFileSync(file), before, 'refused export preserves every board byte');
  assert.equal(readEventLogVersion(file), String(EVENT_LOG_VERSION + 1));
});
