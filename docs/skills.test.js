/** @pullboard-test-input skills/pullboard-plan/SKILL.md */
/** The shipped skills teach one lean loop and none of the patterns that make builders wait */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const skillsDirectory = new URL('../skills/', import.meta.url);
const skills = readdirSync(skillsDirectory, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => ({ name: entry.name, text: readFileSync(new URL(`${entry.name}/SKILL.md`, skillsDirectory), 'utf8') }));
/** @pullboard-world-pin reads the shipped plan skill to verify the instructions covered by the planning bar. */
const planSkill = readFileSync(new URL('../skills/pullboard-plan/SKILL.md', import.meta.url), 'utf8');

/** Return the run skill's lean-loop section, from its heading to the next heading. */
function leanLoop() {
  const run = skills.find(skill => skill.name === 'pullboard-run').text;
  const start = run.indexOf('\nYou are the coordinator');
  assert.notEqual(start, -1, 'the run skill opens with the coordinator rules');
  const end = run.indexOf('\n## ', start + 1);
  return run.slice(start, end < 0 ? run.length : end).replace(/\s+/gu, ' ');
}

test('clause 1: the skills teach the no-wait loop [N31]', () => {
  const section = leanLoop();
  assert.match(section, /Builders build lane items in their own worktrees\. Never you\./u, 'builders build in their own worktrees, never the coordinator');
  assert.match(section, /Never wait\. The board holds the state; you act on what it reports\./u, 'the board does the waiting');
  const run = skills.find(skill => skill.name === 'pullboard-run').text.replace(/\s+/gu, ' ');
  assert.match(run, /Builders never wait: submit queues the gate and returns, and they run `pullboard next` at once\./u, 'builders submit and move on');
});

test('clause 2: no shipped skill teaches a sleep loop, a status poll or a main-checkout build [N31]', () => {
  const discouraged = [
    [/(^|[\s;&|(`])sleep\s+\d/mu, 'a sleep command'],
    [/\bwhile\s+(true|:|\[)/u, 'a while loop'],
    [/\buntil\s+\S+.*;\s*do\b/u, 'an until loop'],
    [/\bwatch\s+(-n\s*\d+\s+)?pullboard\b/u, 'a watch around the board'],
    [/\bnode --test\b(?![^\n]*--check)(?![^\n]*\.test\.js)/u, 'a broad node --test run'],
    [/\b(npm test|npm run gate)\b/u, 'a whole-suite run'],
  ];
  for (const skill of skills) {
    // Setting the repo's own test command is board setup, not a builder habit.
    const text = skill.text.split('\n').filter(line => !line.includes('pullboard gate set')).join('\n');
    for (const [pattern, label] of discouraged) {
      const found = text.match(pattern);
      assert.equal(found, null, `${skill.name} teaches ${label}: ${found?.[0]}`);
    }
  }
});

test('docs.skills.plan-one-item-per-file: clause 1: plan items keep source and test together and split above about 400 new lines [N31]', () => {
  assert.match(planSkill, /One item per source file\. Keep a module and its test file in the same item\. Split only when the change is more than about 400 new lines\./u);
});

test('docs.skills.plan-layers-as-wide-as-seats: clause 2: plan only code dependencies and re-cut work below seat capacity [N31]', () => {
  assert.match(planSkill, /`--after` only where code imports another item's file\. Plan layers as wide as the builder seats\. Before filing, count the items buildable at once; if that count is below the number of seats, re-cut the work\./u);
  assert.match(planSkill, /For a whole-module item, use a clause shaped like: `<test file> has one case per public method and documented behavior of <module>, all green`/u);
});
