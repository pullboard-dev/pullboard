/** @pullboard-test-input packages/gate/tests/fixtures/testkit.js */
/** Keep fixture creation behind one live-rule-aware testkit helper [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

/** Exercise real CLI add and join admissions, then lint fixture call sites and option ownership. */
async function fixtureAdmissionProof(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Live helper item', args: ['--specs', 'G1'] });
  assert.equal(item.item_lane, 'web');
  assert.equal(item.item_route, 'strong');
  assert.match(item.item_brief, /Files:[\s\S]*Change:[\s\S]*Test:/u);
  const identity = (await box.runLocal(box.web, 'whoami', '--json'));
  assert.equal(identity.code, 0, identity.err);
  assert.equal(JSON.parse(identity.out).model, FIXTURE_MODEL);
  const log = (await box.runLocal(box.repo, 'log', String(item.item_id), '--json'));
  assert.equal(log.code, 0, log.err);
  assert.match(log.out, /diagnosis/u);
  const invalidJoin = joinFixtureSeat(box, box.web, 'web', { model: '' });
  assert.notEqual(invalidJoin.code, 0, 'an empty model must still fail live admission');

  const fixtureFiles = [
    { name: '../../tests/fixtures/e2e.js', helpers: ['fileFixtureItem', 'joinFixtureSeat'] },
    { name: '../../tests/fixtures/land/project.js', helpers: ['fileFixtureItem', 'joinFixtureSeat'] },
    { name: '../../tests/fixtures/board/submit.js', helpers: [] },
    { name: '../../tests/fixtures/land/per.js', helpers: ['fileFixtureItem', 'joinFixtureSeat'] },
    { name: '../../tests/fixtures/worktree/maintenance.js', helpers: ['fileFixtureItem', 'joinFixtureSeat'] },
    { name: '../../tests/fixtures/submit/outcome.js', helpers: ['fileFixtureItem', 'createFixtureWorktree'] },
    { name: '../../tests/fixtures/submit/red.js', helpers: ['fileFixtureItem', 'createFixtureWorktree'] },
  ];
  for (const { name: file, helpers } of fixtureFiles) {
    const source = readFileSync(join(import.meta.dirname, file), 'utf8');
    assert.doesNotMatch(source, /(?:\.run|\bcli)\(\s*[^,\n]+,\s*['"](?:add|join)['"](?=\s*[,\)])/u, `${file} delegates CLI fixture admission to testkit-fixture.js`);
    assert.doesNotMatch(source, /--(?:route|brief|model)\b/u, `${file} leaves admission flags to testkit-fixture.js`);
    for (const helperName of helpers) {
      const usage = new RegExp(String.raw`\b${helperName}\b`, 'u');
      assert.match(source, usage, `${file} uses ${helperName}`);
      assert.doesNotMatch(`prefix${helperName}Suffix`, usage, 'helper names require real word boundaries');
    }
  }
  const helper = readFileSync(join(import.meta.dirname, '../../../../packages/gate/tests/fixtures/testkit.js'), 'utf8');
  for (const flag of ['--route', '--brief', '--model']) assert.match(helper, new RegExp(flag));
}

test('cli.journeys-init-testkit.testkit-fixture-helper-satisfies-live-add: testkit fixture helper satisfies live add and join rules and owns fixture admission flags [C7] clause 1 clause 2', fixtureAdmissionProof);

test('cli.journeys-init-testkit.project-runs-its-setup-init-and: project() runs its setup init and join in the warm worker with no Node launch, unless a test replaced run [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const counted = box => {
    const launched = [];
    const run = box.run;
    box.run = (cwd, ...args) => { launched.push(args[0]); return run(cwd, ...args); };
    return launched;
  };
  const warm = helpers.sandbox();
  const warmLaunches = counted(warm);
  warm.runSync.of = warm.run;
  const project = helpers.project('true', warm);
  assert.deepEqual(warmLaunches, [], 'init and join start no Node process');
  assert.ok(existsSync(join(project.repo, '.git/pullboard')), 'the in-process init created the board');
  const seat = JSON.parse((project.run(project.web, 'whoami', '--json')).out);
  assert.equal(seat.lane, 'web', 'the in-process join registered the worktree seat');
  const replaced = helpers.sandbox();
  const replacedLaunches = counted(replaced);
  helpers.project('true', replaced);
  assert.deepEqual(replacedLaunches, ['init', 'join'], 'a replaced run still answers the setup calls');
});
