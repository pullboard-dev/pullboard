/**
 * What a person sees while a gate waits for the machine queue [C7]: one line per new place in the
 * queue, one line per memory state and one line when a runner drops out. src/cli.js re-exports it.
 */

/** Build de-duplicated queue messages for a gate waiting on machine capacity or memory; tests read it through src/cli.js. */
export function gateWaitReporter(io) {
  let last = '';
  let warned = false;
  let held = false;
  return ({ holders = [], position, memory, runnerUnavailable, admitted }) => {
    // An inherited gate slot is admitted at once: there is no queue to describe.
    if (admitted) return;
    if (runnerUnavailable) {
      io.say(`runner ${runnerUnavailable.host} unavailable: ${runnerUnavailable.reason}; until ${runnerUnavailable.until}; requeueing the run`);
      return;
    }
    // Memory speaks once per state: one warning where it cannot be read, one line per hold.
    if (memory && !memory.checked) {
      if (!warned) io.say(memory.warning);
      warned = true;
      if (!position) return;
    }
    if (memory?.held) {
      if (!held) io.say(memory.line);
      held = true;
      last = '';
      return;
    }
    held = false;
    const repos = holders.map(({ repo }) => repo).filter(Boolean);
    const message = `gate waiting: ${holders.length} running${repos.length ? ` in ${repos.join(', ')}` : ''}; place ${position}`;
    if (message !== last) {
      io.say(message);
      last = message;
    }
  };
}
