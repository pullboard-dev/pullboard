/** @pullboard-test-input source-cell link */
/** relay on --all names each excluded board with the one command that relinks it, and --only relinks just that board [C7,#9416]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayExclusion } from '../../../src/io/relay/exclusion.js';
import { updateRelayMachine } from '../../../src/io/relay/machine.js';
import { linkProjects } from '../../../src/io/relay/setup.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';

const SESSION = { url: 'https://relay.example.test' };

/** Two registered boards, both excluded, under a private machine home; a stub relay records every link it is asked for. */
function setup(t) {
  const files = privateFixtureFiles('pullboard-on-all-excluded-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(files.root, 'machine-home');
  mkdirSync(home, { recursive: true });
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const projects = ['alpha', 'beta'].map(name => {
    const root = join(files.root, name);
    mkdirSync(root);
    const step = (...args) => runFixtureGit(args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    step('init', '-q', '-b', 'main');
    step('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    return { root, name };
  });
  updateRelayMachine(state => { state.excluded = projects.map(project => project.root); });
  const said = [];
  const io = { say: line => said.push(line), err: line => said.push(line) };
  const calls = [];
  const link = async (root) => { calls.push(root); return { board: 'board-' + root.split('/').pop() }; };
  return { projects, io, said, calls, link };
}

test('link.relay-on-all.names-excluded-boards: clause 1: pullboard relay on --all prints, for each excluded board, a line naming it and the exact command that relinks it [C7,#9416]', async t => {
  const { projects, io, said, calls, link } = setup(t);
  const result = await linkProjects(SESSION, io, { projects, link });
  assert.deepEqual(calls, [], 'an excluded board is not linked without --only');
  assert.deepEqual(result.linked, []);
  for (const { name } of projects) {
    const line = said.find(text => text.includes(`Did not link ${name}`));
    assert.ok(line, `${name} is named`);
    assert.ok(line.includes(`pullboard relay on --all --only ${name}`), `${name}: ${line}`);
  }
  for (const { root } of projects) assert.ok(relayExclusion(root), 'the exclusion is untouched');
});

test('link.relay-on-all.only-relinks-one: clause 2: relay on --all --only <name> clears that one board\'s exclusion and links only that board, with the way out in the message [C7,#9416]', async t => {
  const { projects, io, said, calls, link } = setup(t);
  const [alpha, beta] = projects;
  const result = await linkProjects(SESSION, io, { projects, link, only: 'alpha' });
  assert.deepEqual(calls, [alpha.root], 'only the named board is linked');
  assert.deepEqual(result.linked.map(entry => entry.project), ['alpha']);
  assert.equal(relayExclusion(alpha.root), null, 'its exclusion is cleared');
  assert.ok(relayExclusion(beta.root), 'the other board stays excluded');
  assert.ok(said.includes('Linked alpha.'));
  assert.ok(!said.some(text => text.includes('excluded from automatic linking')), 'no dead-end exclusion line');
  await assert.rejects(linkProjects(SESSION, io, { projects, link, only: 'gamma' }), error => error.code === 'USAGE' && /alpha, beta/u.test(error.message));
  assert.deepEqual(calls, [alpha.root], 'an unknown name links nothing');
});
