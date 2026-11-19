/**
 * End to end on real repos: the run pack and the moved bar, split from e2e.test.js so each file fits its budget [N21,V11,C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { describe } from 'node:test';
import { it } from 'node:test';

import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';
/** Cases are collected, then run concurrently: each owns its sandbox, repo and machine home, so they overlap their waits instead of adding them [C7]. */
const cases = [];
/** Register one case; it runs inside the concurrent suite at the end of this file. */
const test = (name, body) => cases.push([name, body]);

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { SPEC, commitFile, LIGHT_BRIEF } = e2e;

const { project } = e2e;

/** File light work at mid, then route it light through the coordinator's diagnosis, as the board now requires. */
async function addDiagnosedLight(box, title, ...flags) {
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', title, ...flags);
  assert.equal(added.code, 0, added.err || added.out);
  const id = added.out.match(/^#(\d+)/m)?.[1];
  assert.ok(id, added.out);
  const diagnosis = (await box.runLocal(box.repo, 'fact', id, 'diagnosis', LIGHT_BRIEF));
  assert.equal(diagnosis.code, 0, diagnosis.err || diagnosis.out);
  return added;
}

test('cli.journeys-resume-e2e-pack.the-run-pack-names-verified-items: the run pack names verified items that touched the same files, so a cold agent follows them [N21]', async () => {
  const box = project();
  const script = (name, lines) => {
    writeFileSync(join(box.dir, name), ['#!/bin/sh', 'mkdir -p web', ...lines, ''].join('\n'));
    return `sh ${join(box.dir, name)}`;
  };
  const greet = script('greet.sh', ["echo \"export const title = 'Hi';\" > web/page.js"]);
  const follow = script('follow.sh', ['grep -q "^- #1 Greet: web/page.js$" "$PULLBOARD_PACK" && echo "export const bye = \'Bye\';" >> web/page.js']);
  await addDiagnosedLight(box, 'Greet', '--route', 'mid', '--criterion', 'says Hi', '--check', 'grep -q Hi web/page.js', '--brief', LIGHT_BRIEF);
  const runner = (await box.runLocal(box.repo, 'worktree', 'web', '--route', 'light')).out.match(/^made (\S+) /)[1];
  assert.match((await box.runLocal(runner, 'run', '--agent-light', greet, '--attempts', '1')).out, /#1 is in the gate as job /);
  await settledGateJob(box, 1); // the pulled gate records the item commit only once its receipt is applied [C7]
  const firstCommit = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', firstCommit);
  assert.match((await box.runLocal(box.web, 'verify', '1', 'accept', '--note', 'emptied the page; the check failed')).out, /verified #1/);
  // Accepted work still blocks colliding pulls until it actually lands (#1114).
  box.git(box.repo, 'merge', '-q', '--ff-only', firstCommit);
  const landed = (await box.runLocal(box.repo, 'merged', '1', firstCommit));
  assert.equal(landed.code, 0, landed.err);
  await addDiagnosedLight(box, 'Say bye', '--route', 'mid', '--criterion', 'says Bye', '--check', 'grep -q Bye web/page.js', '--brief', LIGHT_BRIEF);
  const ran = (await box.runLocal(runner, 'run', '--agent-light', follow, '--attempts', '1'));
  assert.match(ran.out, /#2 is in the gate as job /, ran.out);
  const packs = join(box.dir, 'repo', '.git', 'worktrees', runner.split('/').at(-1), 'pullboard', 'packs');
  assert.match(readFileSync(join(packs, '2-light-1.md'), 'utf8'), /## Finished items that touched the same files\n- #1 Greet: web\/page.js\nFollow the patterns/);
});

test('cli.journeys-resume-e2e-pack.submit-refuses-a-bar-that-moved: submit refuses a bar that moved since the claim, before any verifier runs; a refreeze and a fresh claim recover [V11]', async () => {
  const box = project();
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
  (await box.runLocal(box.web, 'claim', '1'));
  fixtureProjectPolicy(box.repo, { config: JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')), spec: SPEC.replace('The page renders.', 'The page renders a heading.') });
  assert.equal((await box.runLocal(box.repo, 'spec', 'approve', 'G1')).code, 0);
  box.git(box.repo, 'commit', '-qam', 'docs: tighten G1');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  await commitFile(box, box.web, 'web/a.html', '<h1>Hi</h1>', 'feat(web): page [G1]');
  const refused = (await box.runLocal(box.web, 'submit', '1'));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /CRITERIA_CHANGED\] the spec rows #1 cites changed after it was claimed, so no verifier could judge it; the coordinator runs pullboard refreeze 1, then you claim it and submit again/);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).item_status, 'claimed');
  assert.match((await box.runLocal(box.repo, 'refreeze', '1')).out, /refrozen/);
  (await box.runLocal(box.web, 'claim', '1'));
  assert.match((await box.runLocal(box.web, 'submit', '1')).out, /#1 is in the gate as job /);
});

describe('resume pack journeys [N21,V11,C7]', { concurrency: true }, () => {
  for (const [name, body] of cases) it(name, body);
});
