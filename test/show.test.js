/**
 * show stays short to read (N30): the latest verdict in full, each earlier one as a line, and every
 * note in full on --history or --json.
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, runFixtureChild } from './fixture-child.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { loadConfig } from '../src/config.js';
import { frozenCriterion, loadSpec } from '../src/spec.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A family emoji: five code points, eight UTF-16 units, one character to a reader. */
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);

/** 119 plain characters, so the emoji after them is the 120th, the last one show keeps. */
const LEAD = `First reject: ${'the empty name crashes '.repeat(5)}`.slice(0, 119);

const NOTES = [
  `${LEAD}${FAMILY} and the line keeps going past the cut.\nRepro: greet("") throws.\nFix: guard the empty case.`,
  'Second reject: the guard returns undefined.\r\nRepro: greet("") is undefined.\r\nFix: return a default.',
  'Accept: greet("") now says hello, stranger.\nBroke it by removing the default; the test went red.\nRestored; green.',
];

/** An earlier note of exactly 120 characters on one line: printed whole, with nothing to hint at. */
const EXACT = `Too slow: ${'x'.repeat(110)}`;

/** Every break Unicode makes mandatory (UAX #14); each one ends a note's first line. */
const BREAKS = {
  LF: '\n',
  CR: '\r',
  CRLF: '\r\n',
  VT: String.fromCharCode(0x0b),
  FF: String.fromCharCode(0x0c),
  NEL: String.fromCharCode(0x85),
  LS: String.fromCharCode(0x2028),
  PS: String.fromCharCode(0x2029),
};

test('show prints the latest verdict in full and earlier ones as one line; --history and --json print every note [N30]', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-show-')));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
  };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { web: { owns: ['web/'] } } }));
  writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] It greets. | gate: test\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, env });
  execFileSync('git', ['commit', '-q', '-m', 'chore: a spec'], { cwd: repo, env });

  const freeze = (item) => frozenCriterion(loadSpec(repo, loadConfig(repo)), item);
  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.register(board, { lane: 'coordinator', path: repo });
    store.register(board, { lane: 'web', path: join(dir, 'web-1') });
    store.register(board, { lane: 'web', path: join(dir, 'web-2') });
    /**
     * Builds an item through one round per note: every round but the last is sent back.
     *
     * @param {string} title
     * @param {string[]} notes
     * @param {string[]} letters - Each round's commit, as one letter repeated.
     */
    const rounds = (title, notes, letters) => {
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title, criterion: 'greet("") says hello, stranger', specIds: ['G1'] });
      notes.forEach((note, round) => {
        const commit = letters[round].repeat(40);
        store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
        store.submit(board, id, { agentId: 'web-1', commit, tree: 't' });
        const decision = round < notes.length - 1 ? 'REJECT' : 'ACCEPT';
        const reason = decision === 'REJECT' ? 'TEST_FAILURE' : undefined;
        store.verify(board, id, { agentId: 'web-2', decision, reason, note, head: commit, digest: freeze(store.getItem(board, id)).digest, policy: 'any' });
      });
    };
    rounds('Greet', NOTES, ['a', 'b', 'c']);
    rounds('Greet fast', [EXACT, 'Accept: fast now.'], ['d', 'e']);
    const broken = Object.entries(BREAKS).map(([name, end]) => `Break ${name} first.${end}hidden after ${name}`);
    rounds('Greet on every break', [...broken, 'Accept: every break ends a line.'], ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  } finally {
    store.closeBoard(board);
  }

  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  const plain = run('show', '1');
  assert.equal(plain.status, 0, plain.stderr);
  const verdictLines = plain.stdout.split('\n').filter((line) => /^(REJECT|ACCEPT) /.test(line));
  assert.deepEqual(verdictLines.slice(0, 2), [
    `REJECT TEST_FAILURE by web-2 (unknown) at aaaaaaaaaaaa: ${LEAD}${FAMILY}…`,
    'REJECT TEST_FAILURE by web-2 (unknown) at bbbbbbbbbbbb: Second reject: the guard returns undefined.',
  ], 'earlier verdicts are one line each: decision, reason, verifier, commit, the note\'s first line cut at 120 characters');
  assert.ok(plain.stdout.includes(`ACCEPT CRITERION_MET by web-2 (unknown) at cccccccccccc: ${NOTES[2]}`), 'the latest verdict keeps its full note');
  for (const later of ['keeps going past the cut', 'Repro: greet("") throws.', 'Repro: greet("") is undefined.']) {
    assert.ok(!plain.stdout.includes(later), `an earlier note's cut and later lines are left out: ${later}`);
  }
  assert.match(plain.stdout, /every note in full: pullboard show 1 --history/);

  const history = run('show', '1', '--history');
  assert.equal(history.status, 0, history.stderr);
  for (const note of NOTES) assert.ok(history.stdout.includes(note), `--history prints: ${note.slice(0, 40)}`);
  assert.doesNotMatch(history.stdout, /earlier verdicts shortened/);
  assert.ok(plain.stdout.length < history.stdout.length, 'the plain output is the shorter one');

  const json = JSON.parse(run('show', '1', '--json').stdout);
  assert.deepEqual(json.verdicts.map((verdict) => verdict.verdict_note), NOTES, '--json carries every note in full');

  const whole = run('show', '2');
  assert.equal(whole.status, 0, whole.stderr);
  assert.ok(whole.stdout.includes(`REJECT TEST_FAILURE by web-2 (unknown) at dddddddddddd: ${EXACT}\n`), 'a first line of exactly 120 characters is printed whole');
  assert.doesNotMatch(whole.stdout, /earlier verdicts shortened/, 'no hint when no earlier note was shortened');

  const breaks = run('show', '3');
  assert.equal(breaks.status, 0, breaks.stderr);
  Object.keys(BREAKS).forEach((name, round) => {
    assert.ok(breaks.stdout.includes(`REJECT TEST_FAILURE by web-2 (unknown) at ${String(round + 1).repeat(12)}: Break ${name} first.\n`), `${name} ends the first line`);
  });
  assert.doesNotMatch(breaks.stdout, /hidden after/, 'nothing after any break is printed');
});
