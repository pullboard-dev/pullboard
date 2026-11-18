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

const GUIDE = ['apps/cli/journeys/init/practice.test.js', 'the run guide takes one agent through the whole team'];
const STAGES = ['apps/cli/journeys/merged/e2e.test.js', "the coordinator's resume names its next step"];
const FIRST_WORKTREE = ['apps/cli/journeys/spec/e2e.test.js', "a worktree starts only from a commit that holds pullboard's files"];
const IGNORED_OR_DELETED = ['apps/cli/journeys/spec/e2e.test.js', 'a hook git ignores is committed by force before a worktree'];
const OLD_NODE = ['apps/cli/journeys/version/node.test.js', 'an older Node is told what to install'];

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['N31', 'init and prompt know no run guide', [['apps/cli/src/io/skills.js', "  run: 'pullboard-run',\n", '']], GUIDE, 'red'],
  ['N31', 'the guide lets the coordinator merge by hand', [['skills/pullboard-run/SKILL.md', 'Never merge by hand.', 'Merge by hand when quicker.']], GUIDE, 'red'],
  ['N31', 'the guide lets the coordinator guess what the person wants', [['skills/pullboard-run/SKILL.md', '8. **Ask, never guess:**', '8. **Decide:**']], GUIDE, 'red'],
  ['N32', 'an empty spec is not sent to the person', [['apps/cli/src/io/resume.js', "  if (!live.length && (rows.length || !card.all.length)) return \"turn what the person wants into spec rows with them: the pullboard-decompose skill (pullboard prompt decompose)\";\n", '']], STAGES, 'red'],
  ['N32', 'draft rows are planned before the person approves them', [['apps/cli/src/io/resume.js', "  if (live.length && !approved.length) return 'the person approves rows in SPEC.md; then plan them: the pullboard-plan skill';\n", '']], STAGES, 'red'],
  ['N32', "the coordinator's own claim jumps the spec", [['apps/cli/src/io/resume.js', "  const live = rows.filter((row) => !['wont', 'retired'].includes(row.status));\n", "  if (card.holding.length) return buildNext(card);\n  const live = rows.filter((row) => !['wont', 'retired'].includes(row.status));\n"]], STAGES, 'red'],
  ['N32', "the coordinator's own claim is never named", [['apps/cli/src/io/resume.js', '  if (card.holding.length) return buildNext(card);\n', '']], STAGES, 'red'],
  ['N32', 'verified work is never named for merging', [['apps/cli/src/io/resume.js', '  if (card.toMerge.length) {', '  if (false) {']], STAGES, 'red'],
  ['N32', 'open items get no builders', [['apps/cli/src/io/resume.js', '  if (card.open.length) {\n    const lanes', '  if (false) {\n    const lanes']], STAGES, 'red'],
  ['N32', 'approved rows no item cites are never planned', [['apps/cli/src/io/resume.js', '  if (unplanned.length) {', '  if (false) {']], STAGES, 'red'],
  ['I4', "a worktree starts from a commit without pullboard's files", [['apps/cli/src/io/commands/worktree.js', '  refuseUncommittedSetup(mainRoot, mainConfig);\n', '']], FIRST_WORKTREE, 'red'],
  ['I4', 'once there is a commit, a file changed since passes', [['apps/cli/src/io/worktree.js', '  if (hasCommit && !differ.length) return;', '  if (hasCommit) return;']], FIRST_WORKTREE, 'red'],
  ['I4', 'the hooks are left out', [['apps/cli/src/io/read.js', ", ...(inEach ? [hooks] : [])]", ']']], FIRST_WORKTREE, 'red'],
  ['I4', 'a file never added to git passes', [['packages/git/src/io/main.js', "  for (const path of listed(['ls-files', '-z', '--others', '--exclude-standard', '--', ...paths])) {", '  for (const path of []) {']], FIRST_WORKTREE, 'red'],
  ['C4', 'a deleted file is called changed', [['packages/git/src/io/main.js', "{ A: 'not committed', D: 'deleted' }", "{ A: 'not committed' }"]], FIRST_WORKTREE, 'red'],
  ['C4', 'the command commits everything staged', [['apps/cli/src/io/worktree.js', 'git commit -q -m "${subject}" -- ${words}`);', 'git commit -q -m "${subject}"`);']], FIRST_WORKTREE, 'red'],
  ['I4', 'a hook git ignores passes', [['packages/git/src/io/main.js', "  for (const path of listed(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...paths])) {", '  for (const path of []) {']], IGNORED_OR_DELETED, 'red'],
  ['C4', 'a file git ignores is not added by force', [['apps/cli/src/io/worktree.js', "  const force = differ.some(({ ignored }) => ignored) ? ' -f' : '';", "  const force = '';"]], IGNORED_OR_DELETED, 'red'],
  ['C4', 'a deleted config is sent to init', [['apps/cli/src/io/read.js', "    if (tryGit(info.root, ['cat-file', '-e', `HEAD:${CONFIG_FILE}`]).status === 0) {", '    if (false) {']], IGNORED_OR_DELETED, 'red'],
  ['C4', 'a worktree with no config is told to run init', [['apps/cli/src/io/read.js', '  const config = configHere(info);', '  const config = loadConfig(info.root);']], IGNORED_OR_DELETED, 'red'],
  ['N31', 'the guide does not say to commit before the first worktree', [['skills/pullboard-run/SKILL.md', '4. **Build:** commit what init wrote, the spec and the lanes first; worktrees start from the last commit.', '4. **Build:**']], GUIDE, 'red'],
  ['P3', 'an older Node runs on into a stack trace', [['apps/cli/pullboard.js', 'if (major < 22 || (major === 22 && minor < 13)) {', 'if (false) {']], OLD_NODE, 'red'],
  ['P3', 'Node 22.12 passes the check', [['apps/cli/pullboard.js', 'if (major < 22 || (major === 22 && minor < 13)) {', 'if (major < 22 || (major === 22 && minor < 12)) {']], OLD_NODE, 'red'],
];

audit(MUTANTS);
