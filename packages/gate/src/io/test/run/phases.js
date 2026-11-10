/** Account for completed runner phases, including failures and final cleanup [C7,V4]. */
/** Why: the clock prints itself on `exits`' exit event, so a refused or thrown run still reports its phases (#2425). */
export function testRunPhaseClock({ now = () => performance.now(), write = text => process.stderr.write(text), exits = process } = {}) {
  const started = now();
  let last = started;
  let printed = false;
  const phases = [];
  const clock = {
    /** Close the phase that ran since the previous mark. */
    mark(name) {
      const ended = now();
      phases.push([name, ended - last]);
      last = ended;
    },
    /** Print once, retaining time after the last completed phase as cleanup. */
    print() {
      if (printed) return;
      printed = true;
      const ended = now();
      phases.push(['cleanup', ended - last]);
      const seconds = ms => `${(ms / 1000).toFixed(1)}s`;
      write(`run-tests: phases ${phases.map(([name, ms]) => `${name} ${seconds(ms)}`).join(', ')}, total ${seconds(ended - started)}\n`);
    },
  };
  exits?.once('exit', clock.print);
  return clock;
}
