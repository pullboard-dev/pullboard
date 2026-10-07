/**
 * The proof that one sentence to an agent starts the team (item #66): the run guide (N31), the
 * coordinator's resume (N32) and init's word to an agent (I9). And that the first worktree starts
 * with pullboard's files, or says what to commit (item #69: I4, C4), and that an older Node is told
 * what to install (item #73: P3, P4). Each change below removes one of them, and its test must go red.
 * The harness works on a temporary copy, never a real checkout.
 *
 * Run it from the repo root: node docs/proof/run-mutants.mjs
 */
import { audit } from './harness.mjs';

const GUIDE = ['test/practice.test.js', 'the run guide takes one agent through the whole team'];
const STAGES = ['test/e2e.test.js', "the coordinator's resume names its next step"];
const FIRST_WORKTREE = ['test/e2e.test.js', "a worktree starts only from a commit that holds pullboard's files"];
const NO_INIT = ['test/e2e.test.js', 'a worktree whose commit has no pullboard.json is sent to the main checkout'];
const IGNORED_OR_DELETED = ['test/e2e.test.js', 'a hook git ignores is committed by force before a worktree'];
const OLD_NODE = ['test/node-version.test.js', 'an older Node is told what to install'];

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['N31', 'init and prompt know no run guide', [['src/skills.js', "  run: 'pullboard-run',\n", '']], GUIDE, 'red'],
  ['N31', 'AGENTS.md does not name the run guide', [['src/templates.js', ' The agent in the main checkout runs the whole team by the run guide (the pullboard-run skill).', '']], GUIDE, 'red'],
  ['N31', 'the guide drops the rule against merging unverified history', [['skills/pullboard-run/SKILL.md', '   Never merge a commit whose history holds another item\'s commit that is not yet verified.', '   Merge in any order.']], GUIDE, 'red'],
  ['N32', 'an empty spec is not sent to the person', [['src/cli.js', "  if (!live.length) return \"turn what the person wants into spec rows with them: the pullboard-decompose skill (pullboard prompt decompose)\";\n", '']], STAGES, 'red'],
  ['N32', 'draft rows are planned before the person approves them', [['src/cli.js', "  if (!approved.length) return 'the person approves rows in SPEC.md; then plan them: the pullboard-plan skill';\n", '']], STAGES, 'red'],
  ['N32', "the coordinator's own claim jumps the spec", [['src/cli.js', "  if (isMain) next = coordinatorNext(card, loadSpec(root, ctx.config).rows);\n  else if (card.holding.length) next = buildNext(card);", "  if (card.holding.length) next = buildNext(card);\n  else if (isMain) next = coordinatorNext(card, loadSpec(root, ctx.config).rows);"]], STAGES, 'red'],
  ['N32', "the coordinator's own claim is never named", [['src/cli.js', '  if (card.holding.length) return buildNext(card);\n', '']], STAGES, 'red'],
  ['N32', 'verified work is never named for merging', [['src/cli.js', '  if (card.toMerge.length) {', '  if (false) {']], STAGES, 'red'],
  ['N32', 'open items get no builders', [['src/cli.js', '  if (card.open.length) {\n    const lanes', '  if (false) {\n    const lanes']], STAGES, 'red'],
  ['N32', 'approved rows no item cites are never planned', [['src/cli.js', '  if (unplanned.length) {', '  if (false) {']], STAGES, 'red'],
  ['I4', "a worktree starts from a commit without pullboard's files", [['src/cli.js', '  refuseUncommittedSetup(mainRoot, ctx.config);\n', '']], FIRST_WORKTREE, 'red'],
  ['I4', 'once there is a commit, a file changed since passes', [['src/cli.js', '  if (hasCommit && !differ.length) return;', '  if (hasCommit) return;']], FIRST_WORKTREE, 'red'],
  ['I4', 'the hooks are left out', [['src/cli.js', ", ...(inEach ? [hooks] : [])]", ']']], FIRST_WORKTREE, 'red'],
  ['I4', 'a file never added to git passes', [['src/git.js', "  for (const path of listed(['ls-files', '-z', '--others', '--exclude-standard', '--', ...paths])) {", '  for (const path of []) {']], FIRST_WORKTREE, 'red'],
  ['C4', 'a deleted file is called changed', [['src/git.js', "{ A: 'not committed', D: 'deleted' }", "{ A: 'not committed' }"]], FIRST_WORKTREE, 'red'],
  ['C4', 'the command commits everything staged', [['src/cli.js', 'git commit -q -m "${subject}" -- ${words}`);', 'git commit -q -m "${subject}"`);']], FIRST_WORKTREE, 'red'],
  ['I4', 'a hook git ignores passes', [['src/git.js', "  for (const path of listed(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...paths])) {", '  for (const path of []) {']], IGNORED_OR_DELETED, 'red'],
  ['C4', 'a file git ignores is not added by force', [['src/cli.js', "  const force = differ.some(({ ignored }) => ignored) ? ' -f' : '';", "  const force = '';"]], IGNORED_OR_DELETED, 'red'],
  ['C4', 'a deleted config is sent to init', [['src/cli.js', "    if (tryGit(info.root, ['cat-file', '-e', `HEAD:${CONFIG_FILE}`]).status === 0) {", '    if (false) {']], IGNORED_OR_DELETED, 'red'],
  ['C4', 'a worktree with no config is told to run init', [['src/cli.js', '  const config = configHere(info);', '  const config = loadConfig(info.root);']], NO_INIT, 'red'],
  ['N31', 'the guide does not say to commit before the first worktree', [['skills/pullboard-run/SKILL.md', ' A worktree starts from the last commit, so first commit what init wrote, the spec and the lanes; `pullboard worktree` refuses until they are.', '']], GUIDE, 'red'],
  ['P3', 'an older Node runs on into a stack trace', [['bin/pullboard.js', 'if (major < 22 || (major === 22 && minor < 13)) {', 'if (false) {']], OLD_NODE, 'red'],
  ['P3', 'Node 22.12 passes the check', [['bin/pullboard.js', 'if (major < 22 || (major === 22 && minor < 13)) {', 'if (major < 22 || (major === 22 && minor < 12)) {']], OLD_NODE, 'red'],
  ['I9', 'init says nothing to an agent', [['src/cli.js', "      io.say('with an agent: start a new Claude Code session here, which loads the pullboard skills, then tell it what to build; the pullboard-run skill runs the team');\n", '']], STAGES, 'red'],
];

audit(MUTANTS);
