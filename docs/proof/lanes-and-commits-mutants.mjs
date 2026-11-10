/**
 * The proof audit of the lane and commit rows, L1 to L4 and C1 to C5 (item #55), and C7, CI (item
 * #74): for each row, one or more changes that break the row's rule, and the tagged test that must go
 * red under each.
 * The harness works on a temporary copy, never a real checkout.
 *
 * Run it from the repo root: node docs/proof/lanes-and-commits-mutants.mjs
 */
import { audit } from './harness.mjs';

const BAD_LANE = ['test/lanes.test.js', 'a config with a bad lane refuses and names the field'];
const LANE_NAMES = ['test/lanes.test.js', 'lane names list the coordinator first'];
const LONGEST = ['test/lanes.test.js', "the longest owned prefix decides a path's lane"];
const IN_LANE = ['apps/cli/journeys/list/board.test.js', 'a lane commits only inside its folders'];
const HEADER = ['apps/cli/journeys/hooks/main.test.js', 'header format, length, case and period'];
const CITES = ['apps/cli/journeys/hooks/main.test.js', 'feat and fix cite ids; cited ids exist'];
const PRE_PUSH = ['apps/cli/journeys/spec/e2e.test.js', 'pre-push runs the gate once per tree'];
const MERGE_HINT = ['apps/cli/journeys/hooks/main.test.js', 'a refused merge message points to the message git writes'];
const FIXERS = ['apps/cli/journeys/runner/e2e.test.js', 'pre-commit runs the fixers on fully staged files'];
const CI = ['test/ci.test.js', 'CI runs the gate on every push and pull request'];
const BADGE = ['test/ci.test.js', "the README shows the workflow's status badge"];
const BADGE_LINE = '[![gate](https://github.com/pullboard-dev/pullboard/actions/workflows/gate.yml/badge.svg)](https://github.com/pullboard-dev/pullboard/actions/workflows/gate.yml)\n\n';
const PRE_PUSH_RUN = '        const gate = await runGate(info.root, ctx.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, landing, agent: resourceAgent(ctx), onWait: io.gateWaitReporter(io) });\n        if (gate.isCached)';

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['L1', 'a lane may own something other than a list of paths', [['src/config.js', 'if (!isStringList(lane?.owns)) problems.push(', 'if (false) problems.push(']], BAD_LANE, 'red'],
  ['L1', "a lane's specs may be anything", [['src/config.js', 'if (lane?.specs !== undefined && !isStringList(lane.specs)) {', 'if (false) {']], BAD_LANE, 'red'],
  ['L1', "a lane's start may be anything", [['src/config.js', "if (lane?.starts !== undefined && typeof lane.starts !== 'string') {", 'if (false) {']], BAD_LANE, 'red'],
  ['L1', 'a lane may be named all or coordinator', [['src/config.js', "if (!LANE_NAME_RE.test(name) || name === 'all' || name === COORDINATOR) {", 'if (!LANE_NAME_RE.test(name)) {']], BAD_LANE, 'red'],
  ['L1', 'the coordinator is listed last', [['src/lanes.js', 'return [COORDINATOR, ...Object.keys(config.lanes)];', 'return [...Object.keys(config.lanes), COORDINATOR];']], LANE_NAMES, 'red'],
  ['L2', 'the first matching prefix decides, not the longest', [['src/lanes.js', 'if (path.startsWith(prefix) && prefix.length > longest) {', 'if (path.startsWith(prefix) && longest === 0) {']], LONGEST, 'red'],
  ['L2', 'an unowned path belongs to no lane', [['src/lanes.js', '  let owner = COORDINATOR;', "  let owner = '';"]], LONGEST, 'red'],
  ['L3', 'a lane may commit outside its folders', [['packages/commits/src/io/hooks.js', 'const foreign = outOfLane(config, agent.agent_lane, touched);', 'const foreign = [];']], IN_LANE, 'red'],
  ['L3', "a move counts only where it lands, not where it left", [['packages/commits/src/io/hooks.js', 'const paths = fields.slice(index + 1, index + (isMove ? 3 : 2));', 'const paths = fields.slice(index + (isMove ? 2 : 1), index + (isMove ? 3 : 2));']], IN_LANE, 'red'],
  ['L4', 'a worktree that joined no lane may commit', [['packages/commits/src/io/hooks.js', "    problems.push('this worktree has not joined a lane: pullboard join <lane>');\n    return problems;", '    return problems;']], IN_LANE, 'red'],
  ['C1', 'a header of any length passes', [['packages/commits/src/io/hooks.js', 'if (header.length > rules.maxHeader) {', 'if (false) {']], HEADER, 'red'],
  ['C1', 'a header of any type passes', [['packages/commits/src/io/hooks.js', "const typeRe = new RegExp(`^(${rules.types.join('|')})", 'const typeRe = new RegExp(`^([a-z]+)']], HEADER, 'red'],
  ['C1', 'a subject may start uppercase', [['packages/commits/src/io/hooks.js', 'if (/^[A-Z]/.test(subject)) {', 'if (false) {']], HEADER, 'red'],
  ['C1', 'a subject may end with a period', [['packages/commits/src/io/hooks.js', "if (subject.endsWith('.')) problems.push(", 'if (false) problems.push(']], HEADER, 'red'],
  ['C2', 'cited ids need not exist', [['packages/commits/src/io/hooks.js', '...idProblems(spec, ids).map(', '...[].map(']], CITES, 'red'],
  ['C2', 'feat and fix may cite nothing', [['packages/commits/src/io/hooks.js', 'if (type && rules.requireIds.includes(type) && !ids.length) {', 'if (false) {']], CITES, 'red'],
  ['C3', 'pre-push never runs the gate', [['apps/cli/src/io/commands/hook.js', PRE_PUSH_RUN, "        const gate = { isGreen: true, isCached: false, output: '', seconds: 0, log: '' };\n        if (gate.isCached)"]], PRE_PUSH, 'red'],
  ['C3', 'pre-push runs the gate again on a tree that passed', [['apps/cli/src/io/commands/hook.js', PRE_PUSH_RUN, PRE_PUSH_RUN.replace('landing, agent:', 'landing, trustStamp: false, agent:')]], PRE_PUSH, 'red'],
  ['C3', 'pre-push lets through a commit that is not checked out', [['packages/commits/src/io/hooks.js', 'if (commit !== head) problems.push(', 'if (false) problems.push(']], PRE_PUSH, 'red'],
  ['C4', 'a refused merge header does not point to the exempt message', [['packages/commits/src/io/hooks.js', ". For a merge, keep the message git writes, which is exempt: git merge --no-edit'", "'"]], MERGE_HINT, 'red'],
  ['C4', 'a refused header does not show what it saw', [['packages/commits/src/io/hooks.js', ' (saw "${header.slice(0, 60)}")', '']], HEADER, 'red'],
  ['C4', 'a blocked hook drops the note that says what to do', [['apps/cli/src/io/commands/hook.js', ".join('\\n')}\\n${FIX_NOTE}`);", ".join('\\n')}`);"]], IN_LANE, 'red'],
  ['C5', 'no fixer ever runs', [['packages/commits/src/io/hooks.js', '  if (!fixers.length) return [];', '  return [];']], FIXERS, 'red'],
  ['C5', 'a partly staged file is fixed anyway', [['packages/commits/src/io/hooks.js', 'covers(fixer, path) && !unstaged.has(path) && existsSync(join(root, path))', 'covers(fixer, path) && existsSync(join(root, path))']], FIXERS, 'red'],
  ['C5', 'what a fixer fixed is not staged again', [['packages/commits/src/io/hooks.js', "if (result.status === 0) git(root, ['add', '--', ...files]);", "if (false) git(root, ['add', '--', ...files]);"]], FIXERS, 'red'],
  ['C7', 'macOS runs while the repository is private', [['.github/workflows/gate.yml', "    if: ${{ !github.event.repository.private }}\n", '']], CI, 'red'],
  ['C7', 'CI drops the oldest Node it supports', [['.github/workflows/gate.yml', "        node: ['22.13', '24']\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n      - run: npm run gate\n\n  macos:", "        node: ['24']\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n      - run: npm run gate\n\n  macos:"]], CI, 'red'],
  ['C7', 'CI checks out one commit, not the history spec check reads', [['.github/workflows/gate.yml', '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n      - run: npm run gate\n\n  macos:', '      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n      - run: npm run gate\n\n  macos:']], CI, 'red'],
  ['C7', 'a pull request runs no gate', [['.github/workflows/gate.yml', '  pull_request:\n', '']], CI, 'red'],
  ['C7', 'the README shows no badge', [['README.md', BADGE_LINE, '']], BADGE, 'red'],
];

audit(MUTANTS);
