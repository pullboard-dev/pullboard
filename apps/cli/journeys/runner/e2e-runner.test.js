/**
 * End to end on real repos: runner tiers (N16). Dependency conflicts live in e2e-runner-dependent, hold in e2e-runner-hold.
 */
/** @pullboard-test-input source-cell apps/cli apps/lib store */

import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { addDiagnosedLight } from '../../tests/fixtures/runner/diagnosed-light.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  project, LIGHT_BRIEF,
} = e2e;

test('cli.journeys-runner-e2e-runner.one-runner-climbs-the-tiers-an: one runner climbs the tiers: an escalated item goes to the next command, with the earlier tries; it merges the verified work an item waits on [N16]', async () => {
  const box = project();
  const script = (name, lines) => {
    writeFileSync(join(box.dir, name), ['#!/bin/sh', 'mkdir -p web api', ...lines, ''].join('\n'));
    return `sh ${join(box.dir, name)}`;
  };
  const good = script('web.sh', ["echo \"export const title = 'Hi';\" > web/page.js"]);
  const weak = script('weak.sh', ['echo nope > api/server.js']);
  const strong = script('strong.sh', ['grep -q "Earlier tries by a lighter model" "$PULLBOARD_PACK" && echo "export const served = true;" > api/server.js']);
  const brief = (file) => LIGHT_BRIEF.replace('web/page.js', file);
  await addDiagnosedLight(box, 'web', 'Greet', '--route', 'light', '--criterion', 'says Hi', '--check', 'grep -q Hi web/page.js', '--brief', brief('web/page.js'));
  await addDiagnosedLight(box, 'api', 'Serve', 'the', 'page', '--after', '1', '--route', 'light', '--criterion', 'serves it', '--check', 'test -f web/page.js && grep -q served api/server.js', '--brief', brief('api/server.js'));
  const webRunner = (await box.runLocal(box.repo, 'worktree', 'web', '--route', 'light')).out.match(/^made (\S+) /)[1];
  assert.match((await box.runLocal(webRunner, 'run', '--agent-light', good, '--attempts', '1')).out, /#1 is in the gate as job /);
  await settledGateJob(box, 1); // the pulled gate posts its receipt after the run returns [C7]
  const commit = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', commit);
  assert.match((await box.runLocal(box.web, 'verify', '1', 'accept', '--no-next', '--note', 'ran the check, then emptied the file and saw it fail')).out, /verified #1/);
  const apiRunner = (await box.runLocal(box.repo, 'worktree', 'api', '--route', 'mid')).out.match(/^made (\S+) /)[1];
  const ran = await box.runLocal(apiRunner, 'run', '--agent-light', weak, '--agent-mid', strong, '--attempts', '2', '--minutes', '2');
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /#2 attempt 1\/2: running the light agent[\s\S]*#2 escalated light -> mid[\s\S]*#2 attempt 1\/2: running the mid agent\n#2 attempt 1: green[\s\S]*#2 is in the gate as job /);
  assert.match(ran.out, /runner done: 1 submitted, 1 escalated/);
  assert.equal(box.tryGit(apiRunner, 'merge-base', '--is-ancestor', commit, 'HEAD').status, 0);
  const packs = join(box.dir, 'repo', '.git', 'worktrees', apiRunner.split('/').at(-1), 'pullboard', 'packs');
  assert.match(readFileSync(join(packs, '2-mid-1.md'), 'utf8'), /## Earlier tries by a lighter model\n- 2 attempts stayed red/);
  assert.equal(existsSync(join(packs, '2-light-1.md')), true);
});
