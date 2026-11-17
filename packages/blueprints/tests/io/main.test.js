/** @pullboard-test-input source-cell packages/blueprints */
/** Every bundled blueprint is a gallery card, valid, and carries the checks it promises, read through the cell's front door [S1,I1]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { bundledBlueprints } from '../../index.js';
import { readBlueprint } from '../../index.js';
import { parseSpec } from '../../../spec/index.js';

/** Each pullboard.dev/blueprints card's title and rules, word for word, and how many things it asks the person. */
const GALLERY = {
  pullboard: { title: 'Pullboard, built on Pullboard', rules: ['A builder never verifies their own work.', "Every item's check fails before the change and passes after it.", 'Main only moves when the whole test suite passes.'], asks: 0 },
  website: { title: 'Website', rules: ['Every page reads in full with JavaScript turned off.', 'No change leaves a link pointing at a missing page.'], asks: 2 },
  'web-app': { title: 'Web app', rules: ['Every change ships with a test that fails without it.', 'Every page works at phone width before it ships.'], asks: 0 },
  library: { title: 'Open-source library', rules: ['A breaking change bumps the major version.', 'Every public function has a working example in the docs.'], asks: 2 },
  'ios-app': { title: 'iOS app', rules: ['Every screen has a light and a dark screenshot test.', 'No change removes a VoiceOver label from a screen.'], asks: 2 },
  serverless: { title: 'Serverless', rules: ['Every function has an alarm before it ships.', "No function runs past its platform's time limit."], asks: 3 },
  'data-pipeline': { title: 'Data pipeline', rules: ['A schema change ships with its migration.', 'A failed job names the rows and the reason.'], asks: 2 },
  'test-reliability': { title: 'Test reliability', rules: ['No test waits on the wall clock or a fixed sleep.', 'A flake is pinned on a change only after a run without it.'], asks: 1 },
  research: { title: 'Research board', rules: ['Every claim in a finding links to its source.', 'A finding counts only after a second agent rechecks its source.'], asks: 2 },
  writing: { title: 'Writing and blog', rules: ['Every fact in a post links to where it came from.', 'A post publishes only after you approve it.'], asks: 2 },
};

// A starter check ships to someone else's repo: it only runs the project's own tests, so it holds
// no deletion, download, install, remote shell, publish, redirect or command substitution.
const UNSAFE_CHECK = /\b(?:rm|curl|wget|sudo|ssh|scp|install|publish|push|deploy)\b|[>`]|\$\(/u;


test('blueprints.gallery.bundled-and-valid: every gallery blueprint is bundled and valid [S1]', () => {
  assert.deepEqual(bundledBlueprints(), Object.keys(GALLERY).sort(), 'the bundled blueprints are exactly the gallery cards');
  for (const [name, card] of Object.entries(GALLERY)) {
    const blueprint = readBlueprint(name, process.cwd());
    assert.equal(blueprint.name, name);
    assert.equal(blueprint.title, card.title, `${name} carries its card's title`);
    assert.equal(blueprint.by, 'Pullboard', `${name} is made by Pullboard, not a client or private project`);
    const texts = blueprint.rules.map((rule) => rule.text);
    for (const rule of card.rules) assert.ok(texts.includes(rule), `${name} holds its card's rule word for word: ${rule}`);
    for (const rule of blueprint.rules) assert.ok(rule.why.trim().length > 10, `${name} ${rule.key} gives a reason`);
    assert.ok(blueprint.questions.length >= card.asks, `${name} asks at least what its card says it asks`);
  }
});

test('blueprints.starter.criterion-and-check: every bundled starter item carries a criterion and a check [S1,I1]', () => {
  // Every bundled blueprint files at least one starter, and each carries a criterion and a check.
  for (const name of bundledBlueprints()) {
    const blueprint = readBlueprint(name, process.cwd());
    assert.ok(blueprint.items.length >= 1, `${name} files at least one starter item`);
    for (const item of blueprint.items) {
      assert.ok(item.criterion.trim(), `${name} starter ${item.key} carries a criterion`);
      assert.ok(String(item.check ?? '').trim(), `${name} starter ${item.key} carries a check`);
      assert.doesNotMatch(item.check, UNSAFE_CHECK, `${name} starter ${item.key} only runs the project's own tests`);
    }
  }
  const flaky = readBlueprint('test-reliability', process.cwd()).items;
  assert.ok(flaky.some((item) => /flaky/u.test(item.title) && /repeated runs/u.test(item.criterion) && /deterministic/u.test(item.title)),
    'test-reliability files one: find a flaky test by repeated runs, then make it deterministic');
});

test('blueprints.rows.carry-checks: bundled blueprint rows carry their checks [S1,I1]', async () => {
  // Imported here so the file's import lines stay as they are for the items editing them now.
  const { questionText, ruleText, saveBlueprint } = await import('../../index.js');
  const rule = (blueprint, key) => blueprint.rules.find((entry) => entry.key === key);
  const library = readBlueprint('library', process.cwd());
  const reliability = readBlueprint('test-reliability', process.cwd());
  const web = readBlueprint('web-app', process.cwd());

  // library: a row for the changelog its summary promises, with a reason and a gate.
  assert.match(library.summary, /changelog/u);
  const changelog = library.rules.filter((entry) => /\bchangelog\b/u.test(entry.text));
  assert.equal(changelog.length, 1, 'library files one rule for the changelog it promises');
  assert.ok(changelog[0].why.trim() && changelog[0].gate.trim(), 'the changelog rule gives a reason and names a gate');

  // LIB1 and LIB2 carry a machine check: a test file their own starter's check runs, not review.
  for (const key of ['LIB1', 'LIB2']) {
    const { gate } = rule(library, key);
    assert.match(gate, /^test\/[\w.-]+\.test\.js$/u, `${key} names a test file as its gate, a machine check`);
    assert.ok(library.items.some((item) => item.cites.includes(key) && item.check.includes(gate)), `${key}'s gate is a test its own starter's check runs`);
  }
  // LIB1 keeps its card text and says what holds before 1.0.
  assert.equal(rule(library, 'LIB1').text, 'A breaking change bumps the major version.');
  assert.match(ruleText(rule(library, 'LIB1')), /before 1\.0[^.]*\bminor\b/u, 'LIB1 says a breaking change bumps the minor version before 1.0');

  // test-reliability: a flake fix is proven by repeated runs, with a question for the run count.
  const proven = reliability.rules.find((entry) => entry.text === 'A flake fix is proven by repeated runs.');
  assert.ok(proven, 'test-reliability carries "A flake fix is proven by repeated runs."');
  assert.match(proven.gate, /\brun\b.*\bin a row\b/u, 'the flake-fix rule is gated on the repeated runs themselves');
  const runs = reliability.questions.find((entry) => /\bruns in a row\b/u.test(entry.ask));
  assert.ok(runs, 'test-reliability asks how many runs in a row prove a flake fix');
  assert.ok(runs.choices.length <= 12 && runs.choices.every((choice) => /^\d+$/u.test(choice)), 'the run count choices are whole numbers, 12 or fewer');
  assert.match(proven.gate, /run count question/u, 'the flake-fix gate points at the run count question');

  // web-app: its tests bind a local port, so a sandboxed agent asks the person, never rewrites them.
  const port = web.rules.filter((entry) => /\blocal port\b/u.test(entry.text));
  assert.equal(port.length, 1, 'web-app says its tests bind a local port');
  assert.match(port[0].text, /sandbox[^.]*asks the person instead of rewriting the tests/u, 'a sandboxed agent asks the person instead of rewriting the tests');

  // Every row marked must names a gate, in every bundled file, so an approved row passes spec check.
  for (const name of bundledBlueprints()) {
    const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../data/blueprints/${name}.json`), 'utf8'));
    for (const entry of raw.rules ?? []) {
      if (entry.tier !== 'must') continue;
      assert.ok(typeof entry.gate === 'string' && entry.gate.trim(), `${name} ${entry.key} is marked must and names a gate`);
      assert.doesNotMatch(entry.gate, UNSAFE_CHECK, `${name} ${entry.key}'s gate runs nothing unsafe`);
    }
  }

  // The new and changed rows round-trip through blueprint save exactly as written. Save keeps a
  // question only when its row reads back one way, so the run count's default sits between choices.
  const rows = [
    ...[rule(library, 'LIB1'), rule(library, 'LIB2'), changelog[0], proven, port[0]].map((entry, index) => `- R${index + 1} [approved, must] ${ruleText(entry)} | gate: review`),
    `- R9 [approved, must] ${questionText(runs)} | gate: review`,
  ];
  const saved = saveBlueprint(parseSpec(`# Spec\n\n## R · Rows\n\n${rows.join('\n')}\n`), { names: [] });
  assert.deepEqual(saved.left, [], 'no new or changed row is left out of a save');
  assert.deepEqual(saved.blueprint.questions.map(({ ask, choices, default: answer }) => ({ ask, choices, default: answer })), [{ ask: runs.ask, choices: runs.choices, default: runs.default }]);
  assert.equal(saved.blueprint.rules.length, 5);
});
