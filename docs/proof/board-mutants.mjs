/**
 * The proof audit of the board rows that no accepted item had proven (item #53): for each row, one
 * or more changes to src/ that break the row's rule, and the tagged test that must go red under each.
 * The harness works on a temporary copy, never a real checkout.
 *
 * Run it from the repo root: node docs/proof/board-mutants.mjs
 */
import { audit } from './harness.mjs';

const COMMON_DIR = ['apps/cli/journeys/list/board.test.js', 'the board lives in the git common dir'];
const RACE = ['apps/cli/journeys/spec/e2e/next.test.js', 'two agents racing for one item'];
const LEASE = ['apps/cli/journeys/resume/board.test.js', 'a claim is a lease'];
const SHOUTS = ['apps/cli/journeys/resume/board.test.js', 'shouts reach a lane, an agent or all'];
const BRIEF_EDIT = ['apps/cli/journeys/resume/board.test.js', 'an item carries a brief; editing it'];
const BRIEF_SHOWN = ['apps/cli/journeys/runner/e2e.test.js', 'an item carries a brief to whoever claims it'];
const ESCALATE = ['apps/cli/journeys/resume/board.test.js', 'escalate frees an item one tier up'];

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['B1', 'each worktree opens a board of its own', [['apps/cli/src/io/read.js', "const file = join(info.commonDir, 'pullboard', 'board.sqlite');", "const file = join(info.gitDir, 'pullboard', 'board.sqlite');"]], COMMON_DIR, 'red'],
  ['B2', 'a claim skips the check for another live holder', [['packages/store/src/io/board/claim.js', 'notHeldByAnother: (found) => (isHeld(board, found) && found.item_owner !== agentId', 'notHeldByAnother: (found) => (false && isHeld(board, found) && found.item_owner !== agentId']], RACE, 'red'],
  ['B2', 'a move opens a deferred transaction, not an immediate one', [['packages/store/src/io/board/busy.js', "try { db.exec('BEGIN IMMEDIATE'); return; }", "try { db.exec('BEGIN'); return; }"]], RACE, 'red'],
  ['B3', 'the main checkout is not the coordinator', [['packages/git/src/io/main.js', 'isMain: gitDir === commonDir }', 'isMain: false }'], ['packages/git/src/io/main.js', 'isMain: realpathSync.native(commonDir) === realpathSync.native(gitDir) }', 'isMain: false }']], COMMON_DIR, 'red'],
  ['B3', 'an agent is whichever lane agent joined first, not its worktree', [['apps/cli/src/io/read.js', 'const agent = readers.agentAt(board, ctx.info.root) ?? itemFolderIdentity(board, ctx.info.root)?.agent;', 'const agent = store.listAgents(board).find((entry) => entry.agent_lane !== COORDINATOR);']], COMMON_DIR, 'red'],
  ['B4', 'a lapsed claim stays held', [['packages/store/src/io/board/query.js', "return item.item_status === 'claimed' && ((item.item_lease_until ?? '') > now(board) || submitGateInFlight(board, item));", "return item.item_status === 'claimed';"]], LEASE, 'red'],
  ['B4', 'claiming again keeps the old lease', [['packages/store/src/io/board/claim.js', 'item_lease_until: leaseUntil,', 'item_lease_until: isRenewal(found) ? found.item_lease_until : leaseUntil,']], LEASE, 'red'],
  ['B4', 'the default lease is 3h', [['packages/config/src/io/main.js', "lease: '2h',", "lease: '3h',"]], ['packages/config/tests/lanes.test.js', "a claim's lease is 2h"], 'red'],
  ['B6', 'an item may cite an id the spec does not have', [['packages/spec/src/io/main.js', "if (!row) return [`${id} is not in ${namespaced ? 'doctrine' : spec.name ?? 'the spec'}`];", 'if (!row) return [];']], ['apps/cli/journeys/list/board.test.js', 'items cite spec ids that exist'], 'red'],
  ['B7', 'inbox never marks shouts read', [['packages/store/src/logic/board/inbox.js', '  if (markRead && query.seats.some(seat => seat.agent_last_shout_id < acknowledged)) {', '  if (false && markRead && query.seats.some(seat => seat.agent_last_shout_id < acknowledged)) {']], SHOUTS, 'red'],
  ['B7', "a shout to a lane never reaches the lane's agents", [['packages/store/src/logic/board/audience.js', 'return [cursor, seat, seat, lane,', "return [cursor, seat, seat, '',"]], SHOUTS, 'red'],
  ['B7', 'a shout to all reaches nobody', [['packages/store/src/logic/board/audience.js', "shout_to IN ('all', ?, ?)", "shout_to IN ('', ?, ?)"]], SHOUTS, 'red'],
  ['B8', 'an item waiting on another can be claimed anyway', [['packages/store/src/io/board/claim.js', "if (before.item_status !== 'verified' && !((board.executionEngineVersion", 'if (false && !((board.executionEngineVersion']], ['apps/cli/journeys/resume/board.test.js', 'an item can wait on others'], 'red'],
  ['B9', 'submit pins nothing', [['apps/cli/src/io/submit.js', "  git(root, ['update-ref', pin, commit]);\n", '']], ['apps/cli/journeys/gate/slot.test.js', 'submit needs a clean tree, nothing untracked'], 'red'],
  ['B10', "a claimed item's brief cannot be edited", [['packages/store/src/io/board/edit.js', "const moved = ['item_route', 'item_criterion', 'item_check', 'item_after', 'item_check_timing'].filter(", "const moved = ['item_route', 'item_criterion', 'item_check', 'item_after', 'item_check_timing', 'item_brief'].filter("]], BRIEF_EDIT, 'red'],
  ['B10', 'next leaves out the brief', [['apps/cli/src/io/commands/next.js', "        sayBrief(io, item.item_brief);\n        await progress.run('code map'", "        await progress.run('code map'"]], BRIEF_SHOWN, 'red'],
  ['B10', 'show leaves out the brief', [['apps/cli/src/io/commands/show.js', '  sayBrief(io, item.item_brief);\n  for (const move of relayPending)', '  for (const move of relayPending)']], BRIEF_SHOWN, 'red'],
  ['B12', 'any lane may claim any item', [['packages/store/src/io/board/claim.js', '        if (found.item_lane === lane) return null;', '        return null;']], ['apps/lib/tests/logic/native/claims.test.js', 'modern multi-claim retains legacy guards'], 'red'],
  ['B13', 'any route takes any item', [['packages/seats/src/logic/route/escalation.js', 'export const canTake = (agentRoute, itemRoute) => ROUTES.indexOf(itemRoute) <= ROUTES.indexOf(agentRoute);', 'export const canTake = () => true;']], ['apps/cli/journeys/resume/board.test.js', 'routes are tiers'], 'red'],
  ['B14', 'an item below strong needs no brief, criterion or check', [['packages/items/src/logic/routing.js', "  if (route === 'strong') return brief;", '  return brief;']], ['apps/cli/journeys/resume/board.test.js', 'below strong, an item is buildable cold'], 'red'],
  ['B15', 'escalate keeps the route', [['packages/store/src/logic/board/escalate.js', 'const nextRoute = (route) => ROUTES[Math.min(ROUTES.indexOf(route) + 1, ROUTES.length - 1)];', 'const nextRoute = (route) => route;']], ESCALATE, 'red'],
  ['B15', 'escalate drops what was tried', [['packages/store/src/logic/board/escalate.js', 'note: note.trim(), ...(attempt ? { attempt } : {})', "note: '', ...(attempt ? { attempt } : {})"]], ESCALATE, 'red'],
  ['B15', "the runner never pins a failed attempt", [['packages/runners/src/io/run.js', '    git(root, [\'update-ref\', ref, commit]);\n    return ref;', '    return ref;']], ['apps/cli/journeys/runner/e2e.test.js', 'run builds routed items unattended'], 'red'],
];

audit(MUTANTS);
