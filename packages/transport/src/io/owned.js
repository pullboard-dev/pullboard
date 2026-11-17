/** Bound stopping only this owned child and its pipes; local settlement never proves remote cleanup. */
export function ownedTransportCompletion(child, { termMs = 1_000, drainMs = 1_000 } = {}) {
  let term, drain, stopping = false, observed = null, force;
  const forced = new Promise(resolve => { force = resolve; });
  const exited = (status, signal) => { observed = { status, signal }; };
  let closed;
  const complete = new Promise(resolve => { closed = (status, signal) => resolve({ status, signal, forced: false }); });
  child.once('exit', exited); child.once('close', closed);
  return {
    wait: () => Promise.race([complete, forced]),
    stop() {
      if (stopping) return;
      stopping = true;
      child.stdin?.destroy(); child.kill('SIGTERM');
      term = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        drain = setTimeout(() => {
          child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
          force({ ...(observed ?? { status: null, signal: null }), forced: true });
        }, drainMs);
      }, termMs);
    },
    dispose() { clearTimeout(term); clearTimeout(drain); child.removeListener('exit', exited); child.removeListener('close', closed); },
  };
}
