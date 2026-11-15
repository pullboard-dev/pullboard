/** Real local-only initialization, relay opt-in and landing proof [I1,B3,R3,H5]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runFixtureChild } from '../child.js';
import { fixtureAdd } from '../testkit.js';
import { fixtureJoin } from '../testkit.js';

/** Preserve every independent observable failure so the prefeature control proves both paths. */
export function assertNoRemoteLanding(sandbox, commitFile) {
  const box = sandbox();
  const repo = join(box.dir, 'local-repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const initialized = box.run(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  const configFile = join(repo, 'pullboard.json');
  const original = JSON.parse(readFileSync(configFile, 'utf8'));
  const failures = [];
  /** Collect assertions only; setup or execution exceptions remain fatal. */
  const observe = (check) => { try { check(); } catch (error) { if (error.code !== 'ERR_ASSERTION') throw error; failures.push(error.message); } };
  observe(() => assert.equal(original.landing?.publish, 'separate', 'init chooses local-first landing without any remote'));
  writeFileSync(configFile, JSON.stringify({ ...original, gate: 'true', verify: 'any', lanes: { web: { owns: ['web/'], specs: ['G1'] } } }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), '# Local fixture\n\n## Goals\n- G1 [approved, must] The local result exists. | gate: true\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: configure local landing');
  const added = fixtureAdd(box.run, repo, 'web', 'Local result', '--specs', 'G1', '--criterion', 'The result exists.', '--check', 'test -f web/result.txt', '--wait', '--json');
  assert.equal(added.code, 0, added.err);
  const item = JSON.parse(added.out).item.item_id;
  const made = box.run(repo, 'worktree', 'web', '--model', 'local-builder', '--json');
  assert.equal(made.code, 0, made.err);
  const builder = JSON.parse(made.out).path;
  assert.equal(box.run(builder, 'claim', String(item)).code, 0);
  const committed = commitFile(box, builder, 'web/result.txt', 'local result\n', 'feat(web): local result [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = box.run(builder, 'submit', String(item), '--json');
  assert.equal(submitted.code, 0, submitted.err);
  const head = JSON.parse(submitted.out).commit;
  const reviewer = join(box.dir, 'local-reviewer');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  assert.equal(fixtureJoin(box.run, reviewer, 'web', '--model', 'local-reviewer').code, 0);
  const accepted = box.run(reviewer, 'verify', String(item), 'accept', '--note', 'The actual local result exists.', '--json');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);

  const machine = new URL('../../../../../packages/link/index.js', import.meta.url).href;
  const enabled = runFixtureChild(process.execPath, ['--input-type=module', '-e', `import { updateRelayMachine } from ${JSON.stringify(machine)}; updateRelayMachine(state => { state.autoLink = true; });`], { cwd: repo, env: box.env, encoding: 'utf8' });
  assert.equal(enabled.status, 0, enabled.stderr);
  const status = box.run(repo, 'status', '--json');
  observe(() => assert.equal(status.code, 0, status.err));
  observe(() => assert.equal(JSON.parse(status.out).error, undefined, 'an inherited link-all never turns local status into a relay refusal'));
  observe(() => assert.equal(JSON.parse(status.out).relay.linked, false, 'status reports the local board as not linked'));
  const explicit = box.run(repo, 'relay', 'on', '--json');
  observe(() => assert.equal(explicit.code, 1, 'an explicit link still requires a GitHub origin'));
  observe(() => assert.equal(JSON.parse(explicit.out).error.code, 'RELAY_ORIGIN'));
  const landed = box.run(repo, 'land', '--json');
  observe(() => assert.equal(landed.code, 1, landed.err));
  observe(() => assert.equal(JSON.parse(landed.out).error.code, 'BOARD_LANDS_ACCEPTED'));
  const recorded = JSON.parse(box.run(repo, 'show', String(item), '--json').out);
  observe(() => assert.ok(recorded.item_merged_commit, 'acceptance automatically records the landing'));
  observe(() => assert.equal(box.git(repo, 'rev-parse', 'main'), recorded.item_merged_commit));
  observe(() => assert.equal(readFileSync(join(repo, 'web/result.txt'), 'utf8'), 'local result\n'));
  assert.equal(box.git(repo, 'remote'), '', 'the whole workflow retains no remote');
  for (const origin of ['https://github.com/example/local-proof.git', join(box.dir, 'private-origin.git')]) {
    const remoteRepo = join(box.dir, origin.startsWith('https:') ? 'github-repo' : 'bare-repo');
    mkdirSync(remoteRepo);
    box.git(remoteRepo, 'init', '-q', '-b', 'main');
    box.git(remoteRepo, 'remote', 'add', 'origin', origin);
    assert.equal(box.run(remoteRepo, 'init').code, 0);
    const withRemote = JSON.parse(readFileSync(join(remoteRepo, 'pullboard.json'), 'utf8'));
    observe(() => assert.equal(withRemote.landing, undefined, 'a configured remote keeps the existing push-and-land default'));
    observe(() => assert.equal(box.git(remoteRepo, 'remote', 'get-url', 'origin'), origin));
  }
  assert.deepEqual(failures, [], failures.join('\n'));
}
