/** pullboard doctor --hosts names the exact hosts each role needs, and a runner confined to them completes a job [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apiHttpBox } from '../../tests/fixtures/api.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { hostOf } from '../../../../packages/config/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { serveRunner } from '../../../../packages/drive/index.js';

/** Parse the `role: host host` lines doctor --hosts prints into { role: [hosts] }. */
function parseHosts(stdout) {
  return Object.fromEntries(stdout.trim().split('\n').map(line => {
    const [role, rest] = line.split(': ');
    return [role, rest.split(' ')];
  }));
}

test('clause 1: doctor --hosts prints the board URL and git remote hosts for the agent, runner and lander and nothing else [P7]', { timeout: 120_000 }, // budget: hang ceiling for a private init and API start.
async t => {
  const box = await apiHttpBox(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { board: { url: 'https://board.example.test:8443/api', token: 'k' } });
  const file = join(box.root, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), trunk: { remote: 'git@git.example.test:team/repo.git' } }, null, 2));
  const result = await runCliInProcess(['doctor', '--hosts'], { cwd: box.root, env: box.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const expected = ['board.example.test:8443', 'git.example.test:22'];
  assert.deepEqual(parseHosts(result.stdout), { agent: expected, runner: expected, lander: expected });
  assert.equal(hostOf('https://git.example.test/r.git'), 'git.example.test:443');
  assert.equal(hostOf('/srv/trunk.git'), null, 'a local path needs no network host');
});

test('clause 2: a runner that may reach only the hosts doctor --hosts names completes a job [P7]', { timeout: 120_000 }, // budget: hang ceiling for a private init, API start and a git fetch.
async t => {
  const box = await apiHttpBox(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'pull' }, board: { url: box.origin, token: box.key } });
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd, env: box.env, encoding: 'utf8' }).trim();
  const trunk = join(box.dir, 'trunk.git');
  const source = join(box.dir, 'source');
  git(box.dir, 'clone', '-q', '--bare', box.root, trunk);
  git(box.dir, 'clone', '-q', trunk, source);
  writeFileSync(join(source, 'item.txt'), 'item 1\n');
  git(source, 'add', 'item.txt');
  git(source, 'commit', '-q', '-m', 'feat(core): item 1 [P7]');
  git(source, 'push', '-q', trunk, 'HEAD:refs/heads/item/1');
  const commit = git(source, 'rev-parse', 'HEAD');
  const file = join(box.root, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), trunk: { remote: trunk } }, null, 2));
  const hosts = await runCliInProcess(['doctor', '--hosts'], { cwd: box.root, env: box.env });
  assert.equal(hosts.status, 0, hosts.stderr || hosts.stdout);
  const allowed = new Set(parseHosts(hosts.stdout).runner);
  assert.deepEqual([...allowed], [hostOf(box.origin)], 'the trunk is a local path, so the board host is the one allowance');
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => db.close());
  offerJob(db, { id: 'gate:hosts', kind: 'gate', needs: [], candidate: commit, run: [process.execPath, '-e', '0'] });
  const reached = [];
  const confined = async (url, init) => {
    const host = hostOf(String(url));
    reached.push(host);
    if (!allowed.has(host)) throw new Error(`blocked: ${host} is not in the runner allowlist`);
    return fetch(url, init);
  };
  const served = await serveRunner({ board: `${box.origin}${box.path}?k=${box.key}`, runner: 'r-hosts', capabilities: [], cache: join(box.dir, 'runner-cache'), once: true, fetchImpl: confined });
  assert.deepEqual(served.jobs.map(job => job.outcome), ['posted']);
  assert.ok(reached.length > 0 && reached.every(host => allowed.has(host)), `runner reached only ${[...allowed]}; saw ${reached}`);
});
