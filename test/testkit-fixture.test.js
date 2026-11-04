/** Keep fixture creation behind one live-rule-aware testkit helper [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { fileFixtureItem } from './testkit-fixture.js';

/** Exercise real CLI add and join admissions, then lint fixture call sites and option ownership. */
function fixtureAdmissionProof(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Live helper item', args: ['--specs', 'G1'] });
  assert.equal(item.item_lane, 'web');
  assert.equal(item.item_route, 'strong');
  assert.match(item.item_brief, /Files:[\s\S]*Change:[\s\S]*Test:/u);
  assert.match(box.run(box.web, 'whoami', '--json').out, /web-1/u);

  const fixtureFiles = ['e2e-helpers.js', 'land-project-fixture.js', 'board-submit-fixture.js'];
  for (const file of fixtureFiles) {
    const source = readFileSync(join(import.meta.dirname, file), 'utf8');
    assert.doesNotMatch(source, /\.run\([^\n]*,\s*['"](?:add|join)['"]/u, `${file} delegates CLI fixture admission to testkit-fixture.js`);
    assert.doesNotMatch(source, /--(?:route|brief|model)\b/u, `${file} leaves admission flags to testkit-fixture.js`);
  }
  const helper = readFileSync(join(import.meta.dirname, 'testkit-fixture.js'), 'utf8');
  for (const flag of ['--route', '--brief', '--model']) assert.match(helper, new RegExp(flag));
}

test('testkit fixture helper satisfies live add and join rules and owns fixture admission flags [C7]', fixtureAdmissionProof);
