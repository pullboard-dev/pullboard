/**
 * The proof that one sentence to an agent starts the team (item #66): the run guide (N31), the
 * coordinator's resume (N32) and init's word to an agent (I9). Each change below removes one of
 * them, and its test must go red. The harness works on a temporary copy, never a real checkout.
 *
 * Run it from the repo root: node docs/proof/run-mutants.mjs
 */
import { audit } from './harness.mjs';

const GUIDE = ['test/practice.test.js', 'the run guide takes one agent through the whole team'];
const STAGES = ['test/e2e.test.js', "the coordinator's resume names its next step"];

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['N31', 'init and prompt know no run guide', [['src/skills.js', "  run: 'pullboard-run',\n", '']], GUIDE, 'red'],
  ['N31', 'AGENTS.md does not name the run guide', [['src/templates.js', ' The agent in the main checkout runs the whole team by the run guide (the pullboard-run skill).', '']], GUIDE, 'red'],
  ['N31', 'the guide drops the rule against merging unverified history', [['skills/pullboard-run/SKILL.md', '   Never merge a commit whose history holds another item\'s commit that is not yet verified.', '   Merge in any order.']], GUIDE, 'red'],
  ['N32', 'an empty spec is not sent to the person', [['src/cli.js', "  if (!live.length) return \"turn what the person wants into spec rows with them: the pullboard-decompose skill (pullboard prompt decompose)\";\n", '']], STAGES, 'red'],
  ['N32', 'draft rows are planned before the person approves them', [['src/cli.js', "  if (!approved.length) return 'the person approves rows in SPEC.md; then plan them: the pullboard-plan skill';\n", '']], STAGES, 'red'],
  ['N32', 'verified work is never named for merging', [['src/cli.js', '  if (card.toMerge.length) {', '  if (false) {']], STAGES, 'red'],
  ['N32', 'open items get no builders', [['src/cli.js', '  if (card.open.length) {\n    const lanes', '  if (false) {\n    const lanes']], STAGES, 'red'],
  ['N32', 'approved rows no item cites are never planned', [['src/cli.js', '  if (unplanned.length) {', '  if (false) {']], STAGES, 'red'],
  ['I9', 'init says nothing to an agent', [['src/cli.js', "      io.say('with an agent: start a new Claude Code session here, which loads the pullboard skills, then tell it what to build; the pullboard-run skill runs the team');\n", '']], STAGES, 'red'],
];

audit(MUTANTS);
