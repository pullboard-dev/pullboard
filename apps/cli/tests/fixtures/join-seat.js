/** Seat helpers the join tests share: a new unjoined worktree of the fixture project, and a join runner that drops the --route pair [C7,#10993,#10969]. */
import { join } from 'node:path';
import { runCliInProcess } from './process.js';

/** The same run with the --route pair dropped, so join repeats the seat's lane and model alone and answers already joined. */
export function withoutRoute(box) {
  return (cwd, ...args) => {
    const at = args.indexOf('--route');
    return runCliInProcess(at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)], { cwd, env: box.env });
  };
}

/** A new worktree of the fixture project on its own branch, not yet joined. */
export function freshSeat(box, name) {
  const seat = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', seat, '-b', `web/${name}`);
  return seat;
}
