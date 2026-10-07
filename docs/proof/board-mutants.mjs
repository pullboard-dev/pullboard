/**
 * The proof audit of the board rows that no accepted item had proven (item #53): for each row, one
 * or more changes to src/ that break the row's rule, and the tagged test that must go red under each.
 * The harness works on a temporary copy, never a real checkout.
 *
 * Run it from the repo root: node docs/proof/board-mutants.mjs
 */
import { audit } from './harness.mjs';

const COMMON_DIR = ['test/e2e.test.js', 'the board lives in the git common dir'];
const RACE = ['test/e2e.test.js', 'two agents racing for one item'];
const LEASE = ['test/board.test.js', 'a claim is a lease'];
const SHOUTS = ['test/board.test.js', 'shouts reach a lane, an agent or all'];
const BRIEF_EDIT = ['test/board.test.js', 'an item carries a brief; editing it'];
const BRIEF_SHOWN = ['test/e2e.test.js', 'an item carries a brief to whoever claims it'];
const ESCALATE = ['test/board.test.js', 'escalate frees an item one tier up'];

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['B1', 'each worktree opens a board of its own', [['src/cli.js', "const file = join(info.commonDir, 'pullboard', 'board.sqlite');", "const file = join(info.gitDir, 'pullboard', 'board.sqlite');"]], COMMON_DIR, 'red'],
  ['B2', 'a claim skips the check for another live holder', [['src/board.js', 'notHeldByAnother: (found) => (isHeld(board, found) && found.item_owner !== agentId', 'notHeldByAnother: (found) => (false && isHeld(board, found) && found.item_owner !== agentId']], RACE, 'red'],
  ['B2', 'a move opens a deferred transaction, not an immediate one', [['src/board.js', "board.db.exec('BEGIN IMMEDIATE');", "board.db.exec('BEGIN');"]], RACE, 'red'],
  ['B3', 'the main checkout is not the coordinator', [['src/git.js', 'isMain: commonDir === gitDir', 'isMain: false']], COMMON_DIR, 'red'],
  ['B3', 'an agent is whichever lane agent joined first, not its worktree', [['src/cli.js', 'const agent = store.agentAt(board, ctx.info.root);', "const agent = store.listAgents(board).find((entry) => entry.agent_lane !== COORDINATOR);"]], COMMON_DIR, 'red'],
  ['B4', 'a lapsed claim stays held', [['src/board.js', "return item.item_status === 'claimed' && (item.item_lease_until ?? '') > now(board);", "return item.item_status === 'claimed';"]], LEASE, 'red'],
  ['B4', 'claiming again keeps the old lease', [['src/board.js', 'item_lease_until: leaseUntil,', "item_lease_until: isRenewal(found) ? found.item_lease_until : leaseUntil,"]], LEASE, 'red'],
  ['B4', 'the default lease is 3h', [['src/config.js', "lease: '2h',", "lease: '3h',"]], ['test/lanes.test.js', "a claim's lease is 2h"], 'red'],
  ['B6', 'an item may cite an id the spec does not have', [['src/spec.js', "if (!row) return [`${id} is not in ${spec.name ?? 'the spec'}`];", 'if (!row) return [];']], ['test/e2e.test.js', 'items cite spec ids that exist'], 'red'],
  ['B7', 'inbox never marks shouts read', [['src/board.js', "    board.db.prepare('UPDATE agent SET agent_last_shout_id = ? WHERE agent_id = ?').run(last, agentId);\n", '']], SHOUTS, 'red'],
  ['B7', "a shout to a lane never reaches the lane's agents", [['src/board.js', '.all(agent.agent_last_shout_id, agentId, agent.agent_lane, agentId);', ".all(agent.agent_last_shout_id, agentId, '', agentId);"]], SHOUTS, 'red'],
  ['B7', 'a shout to all reaches nobody', [['src/board.js', "shout_to IN ('all', ?, ?)", "shout_to IN ('', ?, ?)"]], SHOUTS, 'red'],
  ['B8', 'an item waiting on another can be claimed anyway', [['src/board.js', "if (before.item_status !== 'verified') {", 'if (false) {']], ['test/board.test.js', 'an item can wait on others'], 'red'],
  ['B9', 'submit pins nothing', [['src/cli.js', "  git(root, ['update-ref', pin, commit]);\n", '']], ['test/e2e.test.js', 'submit needs a clean tree, nothing untracked'], 'red'],
  ['B10', "a claimed item's brief cannot be edited", [['src/board.js', "const moved = ['item_route', 'item_criterion', 'item_check'].filter(", "const moved = ['item_route', 'item_criterion', 'item_check', 'item_brief'].filter("]], BRIEF_EDIT, 'red'],
  ['B10', 'next leaves out the brief', [['src/cli.js', '        sayBrief(io, item.item_brief);\n        io.say(`when it is built and committed:', '        io.say(`when it is built and committed:']], BRIEF_SHOWN, 'red'],
  ['B10', 'show leaves out the brief', [['src/cli.js', '      sayBrief(io, item.item_brief);\n      for (const { item: other, shared } of related) {', '      for (const { item: other, shared } of related) {']], BRIEF_SHOWN, 'red'],
  ['B12', 'any lane may claim any item', [['src/board.js', '          if (found.item_lane === lane) return null;', '          return null;']], ['test/board.test.js', 'one live top-level claim per agent'], 'red'],
  ['B13', 'any route takes any item', [['src/board.js', 'export const canTake = (agentRoute, itemRoute) => ROUTES.indexOf(itemRoute) <= ROUTES.indexOf(agentRoute);', 'export const canTake = () => true;']], ['test/board.test.js', 'routes are tiers'], 'red'],
  ['B14', 'an item below strong needs no brief, criterion or check', [['src/board.js', "  if (route === 'strong') return;", '  return;']], ['test/board.test.js', 'below strong, an item is buildable cold'], 'red'],
  ['B15', 'escalate keeps the route', [['src/board.js', 'const nextRoute = (route) => ROUTES[Math.min(ROUTES.indexOf(route) + 1, ROUTES.length - 1)];', 'const nextRoute = (route) => route;']], ESCALATE, 'red'],
  ['B15', 'escalate drops what was tried', [['src/board.js', 'note: note.trim(), ...(attempt ? { attempt } : {})', "note: '', ...(attempt ? { attempt } : {})"]], ESCALATE, 'red'],
  ['B15', "the runner never pins a failed attempt", [['src/run.js', '    git(root, [\'update-ref\', ref, commit]);\n    return ref;', '    return ref;']], ['test/e2e.test.js', 'run builds routed items unattended'], 'red'],
];

audit(MUTANTS);
