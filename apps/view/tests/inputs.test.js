/** @pullboard-test-input apps/view/tests/** */
/** The view app's tests name the exact files they read, so affected-test selection can see them [C7,U149,#10621]. */
/** @pullboard-world-pin: the clauses read the view app's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';
import { declaresSource } from '../../../packages/gate/src/io/test/inputs.js';
import { testInputProblems } from '../../../packages/gate/src/io/test/inputs.js';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'apps/view/tests/inputs.test.js';
// The tests that read repo files by path, and the header each carries: exact files (or one folder glob), never a cell and never the whole tree.
const READERS = {
  'apps/view/tests/cockpit/relay-cause-message.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/activity.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/shouts.css', 'apps/view/src/io/notch.css'],
  'apps/view/tests/doctrine.test.js': ['docs/rfcs/0001-standard-doctrine.md', 'packages/doctrine/src/io/standard.md'],
  'apps/view/tests/io/activity-narrow.test.js': ['apps/view/src/io/activity.css'],
  'apps/view/tests/io/cost/density.test.js': ['apps/view/src/io/cost.css', 'apps/view/src/io/cost/overview.js'],
  'apps/view/tests/io/cost/frame.test.js': ['apps/view/src/io/cost.css', 'apps/view/src/io/main.css', 'apps/view/src/io/cost/overview.js'],
  'apps/view/tests/io/cost/overview-names.test.js': ['apps/view/data/ceilings/model-names.json', 'apps/view/src/io/cost/overview.js'],
  'apps/view/tests/io/cost/verdicts.test.js': ['apps/view/src/io/cost.css', 'apps/view/src/io/cost/overview.js'],
  'apps/view/tests/io/dashboard-leftovers.test.js': ['apps/view/src/io/page/actions.js'],
  'apps/view/tests/io/headings.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/cost.css', 'apps/view/src/io/page/render.js'],
  'apps/view/tests/io/no-inline-style.test.js': ['apps/view/src/**'],
  'apps/view/tests/io/page/after-paint.test.js': ['apps/view/src/io/page/account.js', 'apps/view/src/io/page/actions.js', 'apps/view/src/io/page/boards.js', 'apps/view/src/io/page/connect.js', 'apps/view/src/io/page/menu.js', 'apps/view/src/io/page/render.js', 'apps/view/src/io/page/shouts.js'],
  'apps/view/tests/io/page/boards.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/activity.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/shouts.css', 'apps/view/src/io/notch.css'],
  'apps/view/tests/io/page/dismiss.test.js': ['apps/view/src/io/page/actions.js'],
  'apps/view/tests/io/page/new-item-control.test.js': ['apps/view/src/io/page/actions.js'],
  'apps/view/tests/io/page/render-names.test.js': ['apps/view/data/ceilings/model-names.json', 'apps/view/src/io/page/render.js'],
  'apps/view/tests/io/palette/palette.test.js': ['apps/view/src/io/palette/client.js', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/palette/index.js', 'apps/view/src/logic/cockpit/prose.js', 'apps/view/src/io/cockpit/page.js', 'apps/view/src/io/page/actions.js'],
  'apps/view/tests/io/phone-leftovers.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/activity.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/shouts.css', 'apps/view/src/io/notch.css'],
  'apps/view/tests/io/phone-widths.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/activity.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/shouts.css', 'apps/view/src/io/notch.css', 'apps/view/src/io/cost.css'],
  'apps/view/tests/io/presentation-names.test.js': ['apps/view/data/ceilings/model-names.json', 'apps/view/src/io/presentation.js'],
  'apps/view/tests/io/roadmap/header-clean.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/activity.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/shouts.css', 'apps/view/src/io/notch.css'],
  'apps/view/tests/io/roadmap/mockup.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/activity.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/shouts.css', 'apps/view/src/io/notch.css'],
  'apps/view/tests/io/roadmap/rows-fit.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/activity.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/shouts.css', 'apps/view/src/io/notch.css'],
  'apps/view/tests/io/roadmap/sheet-marks.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css'],
  'apps/view/tests/io/serve.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/activity.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/shouts.css', 'apps/view/src/io/notch.css'],
  'apps/view/tests/io/shapes.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/activity.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/shouts.css', 'apps/view/src/io/notch.css', 'apps/view/src/io/doctrine.css', 'apps/view/src/io/item/panel.css', 'apps/view/src/io/cost.css', 'apps/view/src/io/no-link.css'],
  'apps/view/tests/io/shout-rows.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/activity.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/shouts.css', 'apps/view/src/io/notch.css'],
  'apps/view/tests/io/spec-detail-order.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/doctrine.css', 'apps/view/src/io/page/render.js'],
  'apps/view/tests/io/spec-rows.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/page/render.js', 'apps/view/src/io/page/actions.js'],
  'apps/view/tests/io/styles.test.js': ['apps/view/src/io/**'],
  'apps/view/tests/io/wording.test.js': ['apps/view/src/**'],
  'apps/view/tests/logic/activity/chart.test.js': ['apps/view/src/logic/activity/flow.js', 'apps/view/src/logic/activity/page.js', 'apps/view/src/logic/activity/slot.js'],
  'apps/view/tests/logic/needs/summary/with.test.js': ['apps/view/src/logic/needs/summary.js', 'apps/view/src/logic/resume.js'],
  'apps/view/tests/logic/panel/head.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/project-menu.css', 'apps/view/src/io/palette/palette.css', 'apps/view/src/io/nav.css', 'apps/view/src/io/item/panel.css', 'apps/view/src/logic/panel/item.js'],
  'apps/view/tests/logic/pipeline/watch.test.js': ['apps/view/src/io/serve.js'],
  'apps/view/tests/logic/render/dashboard/quiet.test.js': ['apps/view/src/io/dashboard.css'],
  'apps/view/tests/logic/summary/roadmap/colors.test.js': ['apps/view/src/io/main.css', 'apps/view/src/io/stage.css', 'apps/view/src/io/item/rows.css', 'apps/view/src/io/dashboard.css', 'apps/view/src/io/cost.css'],
  'apps/view/tests/logic/summary/roadmap/release-list.test.js': ['apps/view/src/io/main.css'],
  'apps/view/tests/needs-door.test.js': ['apps/view/src/**'],
  'apps/view/tests/state-door.test.js': ['apps/view/src/**'],
};

/** Every test file under the view app's tests folder, as repo-relative paths. */
function viewTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return viewTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');

test('view.inputs.declared: clause 1: every view test that reads repo files carries one @pullboard-test-input line naming the exact files it reads, never a whole cell [C7]', () => {
  const files = viewTests();
  assert.ok(files.length > 100, 'the view app has test files to check');
  for (const [file, tokens] of Object.entries(READERS)) {
    assert.ok(files.includes(file), `${file} is a view test`);
    const header = read(file).split(/\r?\n/u).find(line => line.startsWith('/** @pullboard-test-input '));
    assert.equal(header, `/** @pullboard-test-input ${tokens.join(' ')} */`, `${file} names exactly the files it reads`);
    assert.ok(declaresSource(read(file)), `${file} declares its inputs`);
    for (const token of tokens) {
      assert.ok(!/^source-(?:cell|tree)$/u.test(token) && !token.startsWith('/') && !token.includes('..'), `${file}: ${token} is a repo path`);
      assert.ok(existsSync(join(ROOT, token.replace(/\/\*\*$/u, ''))), `${file}: ${token} exists`);
    }
  }
});

test('view.inputs.rule-clean: clause 1: with the outside-src rule on, the reader rule reports none in apps/view/tests, and no view test carries a source-cell or source-tree header [C7]', () => {
  const files = viewTests();
  assert.ok(files.includes(SELF));
  assert.deepEqual(testInputProblems(ROOT, files, read, true), []);
  const cells = files.filter(file => /@pullboard-test-input source-(?:cell|tree)\b/u.test(read(file)));
  assert.deepEqual(cells, []);
});
