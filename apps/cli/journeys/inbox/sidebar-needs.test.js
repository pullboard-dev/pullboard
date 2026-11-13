// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-loads apps/cli/src/io/view.js apps/cli/index.js */
/** Cockpit sidebar progress, tab title and decision counts [N26, N28, B21, B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPEC } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { build } from '../../tests/fixtures/cockpit/harness.js';
import { sendBack } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../tests/fixtures/cockpit/harness.js';
import { projectRows } from '../../tests/fixtures/cockpit/harness.js';
import { productEntries } from '../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../tests/fixtures/cockpit/harness.js';

/**
 * Refresh once the board's latest change is built. The summary route answers at once from the last build and only
 * starts the build that catches up (2a42eb77d4, #6634); a full state read waits for that build, so the refresh after it
 * shows the change in the other boards' rows.
 */
async function refreshAfterBuild(page, view, root) {
  await boardOf(view, root);
  await page.run('refresh()');
}

test("the sidebar shows each product's progress [N28]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha', `${SPEC}- G3 [draft, must] The page has a footer. | gate: web test\n`, { products: { 'Pages <b>': ['G1', 'G3'], Goodbyes: ['G2'] } });
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Footer', '--specs', 'G3', '--criterion', 'has a footer');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  await box.inProcess(alpha.repo, 'add', 'web', 'Header', '--specs', 'G1', '--criterion', 'has a header');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  build(box, alpha, 2, 'footer.html');
  await box.inProcess(alpha.web, 'claim', '3');
  const beta = project(box, 'beta');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.element('products').hidden, false);
    assert.deepEqual(productEntries(page.show('prod-list')), [
      { name: 'Pages &lt;b&gt;', met: '1/2', bar: 50, items: ['1 open (grey)', '1 to verify (verify)', '1 verified (verified)'] },
      { name: 'Goodbyes', met: '0/1', bar: 0, items: ['1 building (building)'] },
    ]);
    // The same numbers pullboard status prints.
    assert.deepEqual((await box.inProcess(alpha.repo, 'status')).split('\n').filter((line) => line.startsWith('product ')), [
      'product Pages <b>: 2 rows, 1 approved, 1 cited by accepted items; items 1 open, 0 building, 1 awaiting verification, 1 verified',
      'product Goodbyes: 1 rows, 1 approved, 0 cited by accepted items; items 0 open, 1 building, 0 awaiting verification, 0 verified',
    ]);
    assert.match(page.show('prod-list'), /title="2 rows in force, 1 approved, 1 cited by accepted items"/);

    await page.click({ root: beta.repo, classes: 'proj side' });
    assert.equal(page.element('products').hidden, true, 'a project that names no products shows none');
  } finally {
    await view.stop();
  }
});
test('the tab title says what needs you [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting');
  build(box, alpha, 2, 'farewell.html');
  const beta = project(box, 'beta');
  await box.inProcess(beta.repo, 'hold', 'web', '--reason', 'G2 is changing');
  const calm = project(box, 'calm');
  const view = await startView(box);
  const nobody = await startView(machine());
  try {
    const page = await openPage(view);
    const title = () => page.run('document.title');
    assert.equal(title(), '(1) alpha · Pullboard', "the lane held in beta; alpha's work sent back or waiting for a verdict is the agents'");
    page.run(`switchTo(${JSON.stringify(calm.repo)})`);
    assert.equal(title(), '(1) calm · Pullboard', 'a switch names the project at once; the count still covers them all');
    await page.run('refresh()');
    assert.equal(title(), '(1) calm · Pullboard');

    await box.inProcess(alpha.repo, 'withdraw', '1', 'the greeting moved to the next release');
    accept(box, alpha, 2);
    await box.inProcess(beta.repo, 'hold', 'web', '--off');
    await refreshAfterBuild(page, view, beta.repo);
    assert.equal(title(), 'calm · Pullboard', 'nothing needs the person, so no count');

    assert.equal((await openPage(nobody)).run('document.title'), 'Pullboard', 'with no project to show');
  } finally {
    await view.stop();
    await nobody.stop();
  }
});
test('an open decision counts in the sidebar and the tab title [B21, B26, N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const beta = project(box, 'beta');
  await box.inProcess(beta.web, 'shout', 'coordinator', 'Ship beta today?', '--decision', '--kind', 'question');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const rows = () => projectRows(page.show('proj-list')).map((row) => [row.name, row.needs, row.line]);
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '', 'nothing open']], "an agent's ask is its coordinator's to answer, so it counts for no one here");

    await box.inProcess(beta.repo, 'pass', '1', 'it changes the launch');
    await refreshAfterBuild(page, view, beta.repo);
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '1', '1 decision']], "passed up, it needs the person, from alpha too");
    assert.equal(page.run('document.title'), '(1) alpha · Pullboard');

    await box.inProcess(beta.repo, 'shout', 'person', 'And the docs?', '--decision');
    await refreshAfterBuild(page, view, beta.repo);
    assert.deepEqual(rows()[1], ['beta', '2', '2 decisions'], 'a coordinator asks the person straight out too');
    await box.inProcess(beta.repo, 'answer', '2', 'yes', '--as', 'person');
    await box.inProcess(beta.repo, 'answer', '3', 'after', '--as', 'person');
    await refreshAfterBuild(page, view, beta.repo);
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '', 'nothing open']], 'answered, they need no one');
    const replies = JSON.parse(await box.inProcess(beta.web, 'inbox', '--json')).shouts.filter((shout) => shout.shout_answers === 1);
    assert.deepEqual(replies.map((shout) => [shout.shout_from, shout.shout_to, shout.shout_answers, shout.shout_text]),
      [['person', 'web-1', 1, 'Person answered #2: yes']], "the person's answer reaches the agent that asked");
    assert.equal(page.run('document.title'), 'alpha · Pullboard');
  } finally {
    await view.stop();
  }
});
