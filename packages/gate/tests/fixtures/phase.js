/** TEMPORARY profiling for #8231: inclusive phase totals printed to stderr at exit. */
const totals = globalThis.__pbPhase ??= new Map();
let hooked = false;

/** Add one timed sample to a phase. */
export function phaseAdd(name, ms) {
  const row = totals.get(name) ?? { n: 0, ms: 0 };
  row.n += 1; row.ms += ms;
  totals.set(name, row);
  if (!hooked) {
    hooked = true;
    process.once('exit', () => {
      const rows = [...totals].sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${k} n=${v.n} ms=${Math.round(v.ms)}`);
      process.stderr.write(`PHASE uptime=${Math.round(process.uptime() * 1000)}\n${rows.map(r => `PHASE ${r}`).join('\n')}\n`);
    });
  }
}

/** Mark a point in time since process start. */
export function phaseMark(name) { phaseAdd(`mark:${name}@${Math.round(process.uptime() * 1000)}`, 0); }

/** Time a sync or async function into a phase. */
export function phaseTime(name, fn) {
  const t0 = performance.now();
  let out;
  try { out = fn(); } catch (error) { phaseAdd(name, performance.now() - t0); throw error; }
  if (out && typeof out.then === 'function') return out.finally(() => phaseAdd(name, performance.now() - t0));
  phaseAdd(name, performance.now() - t0);
  return out;
}
