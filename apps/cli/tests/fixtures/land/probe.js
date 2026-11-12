/** TEMPORARY diagnostic for #6147: count and time every child process per phase. */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
export const spawns = [];
let phase = 'pre';
export function setPhase(name) { phase = name; }
function caller() {
  const lines = (new Error().stack ?? '').split('\n').slice(2);
  const own = lines.filter(line => !line.includes('node:') && !line.includes('probe.js') && !line.includes('git/src/io/adapter.js') && !line.includes('tests/fixtures/'));
  return own.slice(0, 3).map(line => line.trim().replace(/^at /, '').replace(/\(?\/.*?pullboard-local\/[^/]*\/[^/]*\/[^/]*\//, '(').replace(/^.*?\/(apps|packages)\//, '$1/')).join(' < ');
}
function label(cmd, args) { return `${cmd.split('/').pop()} ${(args ?? []).filter(a => !String(a).startsWith('-')).slice(0, cmd.endsWith('git') ? 2 : 1).map(a => String(a).split('/').slice(-2).join('/')).join(' ')}`; }
for (const name of ['spawnSync', 'execFileSync']) {
  const real = childProcess[name];
  childProcess[name] = function (cmd, args, ...rest) {
    const start = performance.now();
    try { return real.call(this, cmd, args, ...rest); }
    finally { spawns.push({ phase, kind: name, label: label(cmd, Array.isArray(args) ? args : []), caller: caller(), ms: performance.now() - start }); }
  };
}
for (const name of ['spawn', 'execFile']) {
  const real = childProcess[name];
  childProcess[name] = function (cmd, args, ...rest) {
    const start = performance.now(); const at = phase; const where = caller();
    const child = real.call(this, cmd, args, ...rest);
    child.once('exit', () => spawns.push({ phase: at, kind: name, label: label(cmd, Array.isArray(args) ? args : []), caller: where, ms: performance.now() - start }));
    return child;
  };
}
syncBuiltinESMExports();
/** Print the per-phase spawn summary, top keys by total time. */
export function report(trace) {
  const by = new Map();
  for (const row of spawns) {
    const p = by.get(row.phase) ?? { n: 0, ms: 0, keys: new Map() }; by.set(row.phase, p);
    p.n += 1; p.ms += row.ms;
    const key = `${row.label} @ ${row.caller}`; const k = p.keys.get(key) ?? { n: 0, ms: 0 }; k.n += 1; k.ms += row.ms; p.keys.set(key, k);
  }
  for (const [name, p] of by) {
    console.log(`# probe ${name}: ${p.n} in-process spawns, ${(p.ms / 1000).toFixed(1)} s`);
    for (const [key, k] of [...p.keys].sort((a, b) => b[1].ms - a[1].ms).slice(0, 30)) console.log(`# probe   ${name} ${k.n}x ${(k.ms / 1000).toFixed(2)} s ${key}`);
  }
  if (trace && existsSync(trace)) {
    const starts = new Map(); const rows = [];
    for (const line of readFileSync(trace, 'utf8').split('\n')) {
      if (!line) continue; let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.event === 'start') starts.set(e.sid, { argv: e.argv, time: e.time });
      if (e.event === 'exit' && starts.has(e.sid)) rows.push({ ...starts.get(e.sid), ms: e.t_abs * 1000 });
      if (e.event === 'child_start' && e.child_class === 'hook') rows.push({ argv: ['HOOK', e.hook_name], time: e.time, ms: 0 });
    }
    const keys = new Map();
    for (const row of rows) { const key = row.argv.slice(1, 3).filter(a => !a.startsWith('-')).join(' '); const k = keys.get(key) ?? { n: 0, ms: 0 }; k.n += 1; k.ms += row.ms; keys.set(key, k); }
    console.log(`# probe trace2 land: ${rows.length} git processes, ${(rows.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)} s`);
    for (const [key, k] of [...keys].sort((a, b) => b[1].ms - a[1].ms).slice(0, 30)) console.log(`# probe   land-git ${k.n}x ${(k.ms / 1000).toFixed(2)} s ${key}`);
  }
}
