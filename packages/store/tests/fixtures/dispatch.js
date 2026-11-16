/** A real repository, SQLite board and seats for store dispatch cases, built through the cell fixtures with no CLI process [N2,V1,B3,C7]. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { appendFact } from '../../index.js';
import { claim } from '../../index.js';
import { editItem } from '../../index.js';
import { getItem } from '../../index.js';
import { heartbeatSeat } from '../../index.js';
import { submitFixture } from './submit.js';
import { cellBoard } from './cell.js';
import { cellItem } from './cell.js';
import { cellProject } from './cell.js';
import { cellSeat } from './cell.js';

const SPEC = '# Dispatch fixture\n## G\n- G1 [approved, must] Work keeps its evidence. | gate: true\n';

/**
 * Isolate real worktrees and shared SQLite; only the explicitly injected clock advances time. The acting seat takes
 * `route`; the builder is strong. Seats of two families sit in two lanes.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ route?: string, family?: string, policy?: string }} [options] - The acting seat's route and the project's verify policy.
 * @returns {{ root: string, file: string, board: object, clock: { now: () => Date }, seats: Record<string, { id: string, path: string, lane: string }>, git: (cwd: string, ...args: string[]) => string, advance: (ms: number) => void, add: Function, claim: Function, submit: Function }}
 */
export function fixture(t, { route = 'strong', family = 'off', policy = 'any' } = {}) {
  const project = cellProject(t, { real: true, spec: SPEC, config: { verify: { policy, family },
    lanes: { web: { owns: ['web/'] }, review: { owns: [] }, docs: { owns: ['docs/'] } } } });
  let at = Date.parse('2026-10-25T10:00:00.000Z');
  const clock = { now: () => new Date(at) };
  const board = cellBoard(t, project.boardFile, clock, { real: true, gitRoot: project.repo });
  const seats = {};
  for (const [name, lane, vendor] of [
    ['actor', 'web', 'Family Alpha'], ['builder', 'web', 'Family Alpha'],
    ['sibling', 'review', 'Family Beta'], ['sameFamily', 'review', 'Family Alpha'],
    ['outside', 'review', 'Family Beta'],
  ]) {
    const path = join(project.dir, name);
    project.git(project.repo, 'worktree', 'add', '-q', '-b', `${lane}/${name}`, path);
    seats[name] = { ...cellSeat(board, { lane, path, family: vendor, route: name === 'actor' ? route : 'strong' }), path };
    heartbeatSeat(board, seats[name].id);
  }
  const box = { root: project.repo, file: project.boardFile, board, clock, seats, git: project.git, advance: ms => { at += ms; } };
  /** File an ordinary runnable item; tests never prefilter a candidate list for next. */
  box.add = (title, options = {}) => {
    const wanted = options.route ?? route;
    const id = cellItem(board, { lane: 'web', title,
      criterion: 'The real fixture succeeds.', check: 'true', specIds: ['G1'],
      brief: `Files: ${options.lane === 'docs' ? 'docs' : 'web'}/dispatch.js\nTest: the real board selects the eligible item and retains its ownership.`, ...options,
      route: wanted === 'light' ? 'mid' : wanted }).item_id;
    if (wanted === 'light') {
      appendFact(board, id, { agentId: seats.builder.id, kind: 'diagnosis',
        text: 'Files: web/dispatch.js\nChange: prepare a small dispatch fixture\nTest case: native next assigns the item to an eligible seat.' });
      if (getItem(board, id).item_route !== 'light') editItem(board, id, { agentId: 'coordinator', route: 'light', reason: 'Private light dispatch fixture' });
    }
    return id;
  };
  /** Set up authentic board ownership without claiming execution of a gate. */
  box.claim = (id, seat = seats.builder) => claim(board, id, { agentId: seat.id, lane: seat.lane,
    leaseMs: 3_600_000, freeze: item => {
      const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    } });
  /** Publish synthetic board state at a real reachable commit, explicitly without a gate receipt. */
  box.submit = id => {
    box.claim(id);
    const head = project.git(seats.builder.path, 'rev-parse', 'HEAD');
    submitFixture(board, id, { agentId: seats.builder.id, commit: head, tree: project.git(project.repo, 'rev-parse', `${head}^{tree}`) });
  };
  return box;
}
