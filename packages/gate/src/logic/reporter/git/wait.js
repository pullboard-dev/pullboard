/**
 * What a person sees while a gate waits for the machine queue [C7]: one line per new place in the
 * queue, one line per memory state and one line when a runner drops out. packages/gate/index.js re-exports it.
 */

/** Build de-duplicated queue messages for a gate waiting on machine capacity or memory; tests read it through the apps/cli door. */
export function gateWaitReporter(io) {
  let last = '';
  let warned = false;
  let held = false;
  return ({ holders, runnerHolders = [], position, memory, runnerUnavailable }) => {
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
    // An inherited or handed-off slot reports { admitted: true } with no queue state: nothing to say.
    if (!Array.isArray(holders)) return;
    const repos = holders.map(({ repo }) => repo).filter(Boolean);
    const hosts = new Map();
    for (const { host } of runnerHolders) hosts.set(host, (hosts.get(host) ?? 0) + 1);
    const remote = [...hosts].map(([host, count]) => `${host}: ${count}`).join(', ');
    const message = `gate waiting: ${holders.length + runnerHolders.length} running${repos.length ? ` in ${repos.join(', ')}` : ''}${remote ? `; runners ${remote}` : ''}; place ${position}`;
    if (message !== last) {
      io.say(message);
      last = message;
    }
  };
}
