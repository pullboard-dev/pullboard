/** Init offers a person one Enter to share with the phone; agents, CI and pipes are never asked [H5,H17,B26]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { acceptsRelayOffer, RELAY_LATER, RELAY_OFFER_QUESTION, RELAY_ON_ALL } from '../src/init.js';
import { SETUP_COMMIT_LATER, SETUP_COMMIT_QUESTION } from '../src/init-finish.js';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';
import { runFixtureChild, safeFixtureDiagnostic, startFixtureChild } from './fixture-child.js';
import { relayClientFixture } from './relay-client-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');
const QUESTION = RELAY_OFFER_QUESTION.trim();
const EXIT_MARK = /pty-exit:(\d+)/u;

/**
 * Quote one word for /bin/sh.
 *
 * @param {string} word
 * @returns {string}
 */
const shellWord = (word) => `'${word.replaceAll("'", "'\\''")}'`;

/** Keep failure messages useful without printing a pairing link's secret or a credential. */
function safeTail(output, env) {
  return safeFixtureDiagnostic(output.replace(/#device=[^\s\x1b]+/gu, '#device=[redacted]'), env).slice(-1500);
}

/**
 * Run pullboard init under a real pseudo-terminal, as a person at a terminal would.
 *
 * There are no dependencies, so the terminal comes from the system's script(1), which macOS and
 * Linux both ship: it opens a pseudo-terminal and runs the command with it as stdin, stdout and
 * controlling terminal, so process.stdin.isTTY and process.stdout.isTTY are true and Ctrl-C is a
 * real SIGINT from the terminal. The two script(1)s take their command differently: BSD script
 * takes it as words after the log file, util-linux script takes one shell string with -c.
 * Node hands a child a socket for a pipe, and BSD script refuses a socket on its stdin, so a
 * /bin/cat pipeline gives script a real pipe to read the keys from. The inner shell prints init's
 * exit code after it, which says when to close the keyboard, so the run never waits on a guess.
 * Proven on macOS (BSD script) and in node:22.13.1-bookworm (util-linux script 2.38).
 *
 * @param {import('node:test').TestContext} t
 * @param {string} cwd
 * @param {Record<string, string>} env
 * @param {{ when: string, send: string }[]} keys - Keys to type once each text appears, in order.
 * @returns {Promise<{ code: number | null, output: string, asked: boolean }>}
 */
function initInTerminal(t, cwd, env, keys = [], setupAnswer = 'n\n', verbose = false) {
  // The shell keeps a trap on SIGINT so Ctrl-C reaches init and still leaves the shell to print
  // init's exit code; dash, Linux's sh, would otherwise die with it. Init itself gets the default.
  const inner = `trap : INT; ${shellWord(process.execPath)} ${shellWord(CLI)} init${verbose ? ' --verbose' : ''}; echo "pty-exit:$?"`;
  const script = process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/sh', '-c', inner] : ['-qec', inner, '/dev/null'];
  const child = startFixtureChild('/bin/sh', ['-c', '/bin/cat | /usr/bin/script "$@"', 'sh', ...script], {
    cwd, env: { ...env, SHELL: '/bin/sh' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  let typed = 0;
  let closedKeyboard = false;
  let answeredSetup = false;
  /** Close the keyboard once; the terminal then reads end of input. */
  const closeKeyboard = () => { if (!closedKeyboard) { closedKeyboard = true; child.stdin.end(); } };
  child.stdout.setEncoding('utf8').on('data', (part) => {
    output += part;
    if (!answeredSetup && output.includes(SETUP_COMMIT_QUESTION.trim())) {
      answeredSetup = true;
      child.stdin.write(setupAnswer);
    }
    while (typed < keys.length && output.includes(keys[typed].when)) child.stdin.write(keys[typed++].send);
    // A question nobody planned to answer gets end of input, so a wrong ask fails instead of hanging.
    if (output.includes(QUESTION) && !keys.some((key) => key.when === QUESTION)) closeKeyboard();
    if (EXIT_MARK.test(output)) closeKeyboard();
  });
  return new Promise((resolveRun, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      const code = EXIT_MARK.exec(output)?.[1];
      resolveRun({ code: code === undefined ? null : Number(code), output, asked: output.includes(QUESTION) });
    });
  });
}

/** Run pullboard init with no terminal at all: stdin is empty and stdout is a pipe. */
function initWithoutTerminal(cwd, env) {
  const result = runFixtureChild(process.execPath, [CLI, 'init'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: result.status, output: `${result.stdout}${result.stderr}`, asked: `${result.stdout}${result.stderr}`.includes(QUESTION) };
}

/** Make a fresh committed repository with a GitHub origin beside the fixture's board. */
function freshRepository(box, name) {
  const root = join(dirname(box.root), name);
  mkdirSync(root);
  box.providerState.repositories.push('repository-' + name); // its own repository: one team board per repository [E12]
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Relay Fixture'], ['config', 'user.email', 'relay-fixture@example.com'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', `git@github.com:fixture/repository-${name}.git`]]) {
    assert.equal(runFixtureChild('git', args, { cwd: root, env: box.env, encoding: 'utf8' }).status, 0);
  }
  return root;
}

/** The environment of the person's own terminal: no agent, SSH or CI marker. */
function personEnvironment(box) {
  const env = { ...box.env };
  for (const name of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS, 'CI']) delete env[name];
  return env;
}

/**
 * Point this machine's saved relay at the loopback relay. Init takes no relay address, and a first
 * sign-in goes to the machine's saved relay, so the fixture saves the loopback one there first;
 * nothing in these tests reaches the real relay or GitHub.
 */
function useLoopbackRelay(box) {
  const machine = resolve(import.meta.dirname, '../src/relay-machine.js');
  const source = `import { updateRelayMachine } from ${JSON.stringify(machine)};
updateRelayMachine((state) => { state.owner = { account: 'fixture-owner', url: ${JSON.stringify(box.origin)} }; });`;
  assert.equal(runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.root, env: box.env, encoding: 'utf8' }).status, 0);
}

/** Count the sign-ins the loopback relay has started. */
const signIns = (box) => box.calls.filter((call) => call.path.startsWith('/auth/device/start')).length;

/** The last line init printed before the shell's exit mark; init ends with its one next step [I1,I2]. */
function lastInitLine(output) {
  const lines = output.split(EXIT_MARK)[0].replace(/\r/gu, '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? '';
}

/** Whether a repository's board is linked to the relay. */
const linked = (root) => existsSync(join(root, '.git', 'pullboard', 'relay.json'));

test('a person at init shares with one Enter [H5,H17,B26]', { timeout: 240_000 }, async (t) => {
  const box = await relayClientFixture(t);
  useLoopbackRelay(box);
  const person = personEnvironment(box);

  await t.test('with relay.offerAtInit false a person is never asked [H5]', async () => {
    const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, `${JSON.stringify({ relay: { offerAtInit: false } })}\n`);
    try {
      const shown = runFixtureChild(process.execPath, [CLI, 'settings'], { cwd: box.root, env: person, encoding: 'utf8' });
      assert.match(shown.stdout, /^relay\.offerAtInit: false/mu, 'pullboard settings shows the setting');
      const run = await initInTerminal(t, freshRepository(box, 'setting-off'), person);
      assert.equal(run.code, 0, `init finishes: ${safeTail(run.output, person)}`);
      assert.equal(run.asked, false, 'the setting turns the question off');
      assert.equal(run.output.includes(RELAY_ON_ALL), false, 'nothing is offered at all');
    } finally {
      writeFileSync(settings, '{}\n');
    }
    const shown = runFixtureChild(process.execPath, [CLI, 'settings'], { cwd: box.root, env: person, encoding: 'utf8' });
    assert.match(shown.stdout, /^relay\.offerAtInit: true/mu, 'the setting is on unless set to false');
  });

  await t.test('n skips sharing and keeps one next step [H5]', async () => {
    const before = signIns(box);
    const root = freshRepository(box, 'answered-no');
    const run = await initInTerminal(t, root, person, [{ when: QUESTION, send: 'n\r' }]);
    assert.equal(run.code, 0, `init finishes: ${safeTail(run.output, person)}`);
    assert.equal(run.asked, true, 'a person at a terminal is asked');
    assert.equal(run.output.split(QUESTION).length - 1, 1, 'the question is asked once');
    assert.equal(run.output.split(QUESTION)[1].includes(RELAY_LATER), false, 'default output leaves the optional recipe behind verbose');
    assert.match(lastInitLine(run.output), /^Next:.*pullboard resume/u, 'the one next step stays last');
    assert.equal(signIns(box), before, 'n starts no sign-in');
    assert.equal(linked(root), false, 'n links nothing');
  });

  await t.test('Enter commits setup while sharing remains a separate choice [I1,I2,H5]', async () => {
    const before = signIns(box);
    const root = freshRepository(box, 'setup-commit-enter');
    const bin = join(root, 'fixture-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(CLI)} "$@"\n`, { mode: 0o700 });
    const terminal = { ...person, PATH: bin + ':' + person.PATH };
    const run = await initInTerminal(t, root, terminal, [{ when: QUESTION, send: 'n\r' }], '\r');
    assert.equal(run.code, 0, safeTail(run.output, person));
    assert.equal(run.output.split(SETUP_COMMIT_QUESTION.trim()).length - 1, 1, 'the setup question appears once');
    assert.match(run.output, /Committed Pullboard setup at [a-f0-9]+/u);
    assert.equal(signIns(box), before, 'setup consent never starts sharing');
    const joined = runFixtureChild(process.execPath, [CLI, 'worktree', 'review', '--model', 'Enter fixture', '--json'],
      { cwd: root, env: terminal, encoding: 'utf8' });
    assert.equal(joined.status, 0, joined.context);
    assert.equal(JSON.parse(joined.stdout).lane, 'review', 'a worktree can join immediately after the one Enter');
  });

  await t.test('Enter signs in, shares every board on this computer and prints the QR [H5,H17]', async () => {
    const before = signIns(box);
    const root = freshRepository(box, 'answered-enter');
    // Ctrl-C at the QR ends the wait for a phone; the boards stay linked.
    const run = await initInTerminal(t, root, person, [{ when: QUESTION, send: '\r' }, { when: '\x1b[30;47m', send: '\x03' }]);
    assert.equal(run.code, 0, `init and its sharing finish: ${safeTail(run.output, person)}`);
    assert.equal(run.output.split(QUESTION).length - 1, 1, 'the question is asked once');
    const after = run.output.split(QUESTION)[1];
    assert.match(after, /Sign in with GitHub: open \S+ and enter \S+/u, 'Enter starts the GitHub sign-in');
    assert.equal(signIns(box), before + 1, 'one sign-in, through the loopback relay');
    for (const board of [box.root, join(dirname(box.root), 'setting-off'), join(dirname(box.root), 'answered-no'), root]) {
      assert.equal(linked(board), true, `every board on this computer is linked: ${board}`);
    }
    assert.match(after, /Pair your phone once: \S+#device=/u, 'the pairing link is printed');
    assert.ok(after.includes('\x1b[30;47m') && after.includes('█'), 'the QR is printed');
    assert.equal(after.includes(RELAY_LATER), false, 'a yes is not told to run the command later');
    assert.match(lastInitLine(run.output), /^Next:.*pullboard resume/u, 'the one next step stays last');
    assert.deepEqual(['', 'y', 'Y', 'yes', ' y '].map(acceptsRelayOffer), [true, true, true, true, true], 'Enter or y is yes');
    assert.deepEqual(['n', 'no', 'later', null].map(acceptsRelayOffer), [false, false, false, false], 'anything else, or a closed terminal, is no');
  });
});

test('an agent or CI init stays noninteractive and shows one next step [H5,B26]', { timeout: 240_000 }, async (t) => {
  const box = await relayClientFixture(t);
  useLoopbackRelay(box);
  const person = personEnvironment(box);
  const before = signIns(box);
  const runs = [
    ['an agent shell, even at a terminal', () => initInTerminal(t, freshRepository(box, 'agent-terminal'), { ...person, AI_AGENT: '1' })],
    ['CI, even at a terminal', () => initInTerminal(t, freshRepository(box, 'ci-terminal'), { ...person, CI: 'true' })],
    ['an SSH shell, even at a terminal', () => initInTerminal(t, freshRepository(box, 'ssh-terminal'), { ...person, SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 2' })],
    ['a run with no terminal', () => initWithoutTerminal(freshRepository(box, 'no-terminal'), person)],
  ];
  for (const [name, start] of runs) {
    const run = await start();
    assert.equal(run.code, 0, `${name}: init finishes: ${safeTail(run.output, person)}`);
    assert.equal(run.asked, false, `${name}: is never asked`);
    assert.equal(run.output.includes(RELAY_LATER), false, `${name}: optional relay recipe stays behind verbose`);
    assert.match(lastInitLine(run.output), /^Next:.*pullboard resume/u, `${name}: one final next step`);
  }
  assert.equal(signIns(box), before, 'no sign-in starts without the person');
});

test('verbose init retains sharing and setup recipes without starting either [I1,I2,H5,B26]', { timeout: 240_000 }, async (t) => {
  const box = await relayClientFixture(t);
  useLoopbackRelay(box);
  const person = personEnvironment(box);
  const before = signIns(box);
  const root = freshRepository(box, 'verbose-recipes');
  const run = await initInTerminal(t, root, person, [{ when: QUESTION, send: 'n\r' }], 'n\n', true);
  assert.equal(run.code, 0, safeTail(run.output, person));
  assert.ok(run.output.includes(RELAY_LATER), 'verbose preserves the optional sharing recipe');
  assert.ok(run.output.includes(SETUP_COMMIT_LATER), 'verbose preserves the deferred setup commit recipe');
  assert.equal(signIns(box), before, 'recipes do not start sign-in');
  assert.equal(linked(root), false, 'declining still links nothing');
});
