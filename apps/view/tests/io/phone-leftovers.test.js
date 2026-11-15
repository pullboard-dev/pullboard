/** @pullboard-test-input source-cell apps/view */
/** #7400: phone tab labels keep their counts, Settings values line up without a copy button, Roadmap after chips never read after with no id [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleListModel } from '../../src/logic/rules.js';
import { segmentedToggle } from '../../src/logic/segmented.js';
import { settingsContentHtml } from '../../src/logic/settings/render.js';
import { composeViewStyles } from '../../src/io/styles.js';
import { cockpitRoadmap } from '../../index.js';
import { milestoneRowHtml } from '../../index.js';
import { roadmapRemainingCount } from '../../index.js';
import { readMilestoneModel } from '../../src/io/roadmap/render.js';
import { roadmapCardsHtml } from '../../src/io/roadmap/render.js';

const rows = [{ id: 'A1', status: 'approved', section: 'S', origin: 'standard' }, { id: 'A2', status: 'pending', section: 'S' }];
const tabs = kind => {
  const { labels, shorts, counts } = ruleListModel(rows, { kind, filter: 'all' });
  return segmentedToggle({ label: 'Rows', attribute: 'data-rows', value: kind + ':all', options: Object.keys(labels).map(key => ({ value: kind + ':' + key, label: labels[key], short: shorts[key], count: counts[key] })) });
};

test('clause 1: Spec and Doctrine tab labels have a one-word phone form and keep their full count [N26]', () => {
  for (const kind of ['spec', 'doctrine']) {
    const html = tabs(kind);
    assert.match(html, /<span class="seg-full">All rows<\/span><span class="seg-short">All<\/span><\/span><b>2<\/b>/u);
    assert.doesNotMatch(html, /seg-short">[^<]*\s[^<]*</u, 'a short label is one word');
  }
  assert.match(tabs('doctrine'), /<span class="seg-full">To review<\/span><span class="seg-short">Review<\/span>/u);
  const css = composeViewStyles();
  assert.match(css, /#spec-chips \.seg-full, #doctrine-chips \.seg-full \{ display: none; \}/u, 'the phone shows the short word');
  assert.match(css, /#spec-chips \.seg-label, #doctrine-chips \.seg-label \{[^}]*overflow: hidden; text-overflow: ellipsis/u, 'a cut label ends in an ellipsis instead of running over its count (#7839)');
  assert.match(css.match(/@media \(max-width: 700px\) \{\n  #spec-chips \.seg, [\s\S]*?\n\}/u)?.[0] ?? '', /text-overflow: ellipsis/u, 'a phone tab label too wide for its chip ends in an ellipsis');
});

test('clause 2: a Settings row with a copy button reserves the copy column, and one without it ends flush at the value [N26,#7718]', () => {
  const entry = { rows: [
    { key: 'gate.slots', scope: 'machine', cli: 'gate-slots', value: 2, default: 2, description: 'd' },
    { key: 'gate.runnerDispatch', scope: 'machine', value: 'pull', default: 'pull', description: 'd' },
  ] };
  const html = settingsContentHtml(entry, 'machine');
  assert.equal(html.match(/class="set[ "]/gu).length, 2);
  assert.equal(html.match(/class="copy"/gu).length, 1, 'only one row has a copy button');
  const css = composeViewStyles();
  assert.equal(html.match(/class="set has-copy[ "]/gu).length, 1, 'only the row with a copy button is marked has-copy');
  assert.match(css, /\n\.set \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/u, 'a row without a copy button has name and value columns only (#7718)');
  assert.match(css, /\n\.set\.has-copy \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto 28px;/u, 'a row with a copy button reserves the copy column');
});

test('clause 3: an after chip with no id is not drawn, and the chips are inline text that can end in an ellipsis [N26]', () => {
  const source = cockpitRoadmap({ milestoneRowHtml, readMilestoneModel, roadmapRemainingCount, roadmapCardsHtml });
  assert.match(source, /\(row\.after \|\| \[\]\)\.filter\(id => id !== null && id !== undefined && String\(id\)\.trim\(\) !== ''\)/u);
  const css = composeViewStyles();
  assert.match(css, /\.milestone-item \.roadmap-afters \.roadmap-after \{ display: inline;/u, 'inline text ends in the ellipsis, an inline-flex chip is cut bare');
  assert.match(css, /\.milestone-item \.roadmap-afters \{[^}]*text-overflow: ellipsis/u);
});
