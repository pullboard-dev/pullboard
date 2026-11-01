/** Present recorded check observations without loading a shell runner [C7,V2]. */
import { provingCheck } from '../../../verify/index.js';
export { provingCheck };

/** Print a recorded observation, including the warning every reviewer must see before work. */
export function sayCheckBaseline(io, item) {
  const base = item.item_check_baseline;
  if (!base) return;
  if (base.result === 'pending') {
    io.say(`check baseline running in the background at main ${base.main}: ${base.command}`);
    return;
  }
  if (base.result === 'unavailable') {
    io.say(`check baseline unavailable: ${base.reason}`);
    return;
  }
  io.say(`check baseline ${base.result} at main ${base.main}${base.reason ? ` (${base.reason})` : ''}: ${base.command}`);
  if (base.result === 'green') {
    io.say(`warning: [CRITERION_PROVES_NOTHING] this check already passes on main; use a check that fails before the work and passes after it, such as one that runs the new test: pullboard edit ${item.item_id} --check "${provingCheck(item)}"`);
  }
}
