/** Keep fixture creation behind one live-rule-aware testkit helper [C7]. */
import assert from 'node:assert/strict';
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
function fixtureAdmissionProof(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Live helper item', args: ['--specs', 'G1'] });
  assert.equal(item.item_lane, 'web');
  assert.equal(item.item_route, 'strong');
  assert.match(item.item_brief, /Files:[\s\S]*Change:[\s\S]*Test:/u);
  const identity = box.run(box.web, 'whoami', '--json');
  assert.equal(identity.code, 0, identity.err);
  assert.equal(JSON.parse(identity.out).model, FIXTURE_MODEL);
  const log = box.run(box.repo, 'log', String(item.item_id), '--json');
  assert.equal(log.code, 0, log.err);
  assert.match(log.out, /diagnosis/u);
  const invalidJoin = joinFixtureSeat(box, box.web, 'web', { model: '' });
  assert.notEqual(invalidJoin.code, 0, 'an empty model must still fail live admission');

  const fixtureFiles = [
    { name: '../../tests/fixtures/e2e.js', helpers: ['fileFixtureItem', 'joinFixtureSeat'] },
    { name: '../../tests/fixtures/land/project.js', helpers: ['fileFixtureItem', 'joinFixtureSeat'] },
    { name: '../../tests/fixtures/board/submit.js', helpers: [] },
    { name: '../land/landing/per.test.js', helpers: ['fileFixtureItem', 'joinFixtureSeat'] },
    { name: '../land/landing/excluded.test.js', helpers: ['fileFixtureItem', 'joinFixtureSeat'] },
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
  const helper = readFileSync(join(import.meta.dirname, '../../tests/fixtures/testkit.js'), 'utf8');
  for (const flag of ['--route', '--brief', '--model']) assert.match(helper, new RegExp(flag));
}

test('testkit fixture helper satisfies live add and join rules and owns fixture admission flags [C7] clause 1 clause 2', fixtureAdmissionProof);
