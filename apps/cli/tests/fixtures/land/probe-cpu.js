/** TEMPORARY diagnostic for #6147: aggregate a V8 CPU profile into top self and inclusive frames. */
import { Session } from 'node:inspector/promises';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
let session = null;
/** Start the in-process profiler. */
export async function startCpu() {
  session = new Session(); session.connect();
  await session.post('Profiler.enable'); await session.post('Profiler.setSamplingInterval', { interval: 500 }); await session.post('Profiler.start');
}
/** Stop the in-process profiler and print its summary. */
export async function stopCpu(name) {
  const { profile } = await session.post('Profiler.stop'); session.disconnect(); session = null;
  summarize(name, profile);
}
function key(frame) { return `${frame.functionName || '(anon)'} ${frame.url.replace(/^.*\/(apps|packages)\//, '$1/').replace(/^file:\/\/.*\//, '')}:${frame.lineNumber + 1}`; }
/** Print top self and inclusive frames for one profile. */
export function summarize(name, profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const self = new Map(); const incl = new Map(); let total = 0;
  profile.samples.forEach((id, index) => {
    const delta = (profile.timeDeltas[index] ?? 0) / 1000; total += delta;
    const node = nodes.get(id); const k = key(node.callFrame); self.set(k, (self.get(k) ?? 0) + delta);
    const seen = new Set();
    for (let at = id; at !== undefined; at = parent.get(at)) { const kk = key(nodes.get(at).callFrame); if (seen.has(kk)) continue; seen.add(kk); incl.set(kk, (incl.get(kk) ?? 0) + delta); }
  });
  console.log(`# cpu ${name}: ${(total / 1000).toFixed(1)} s sampled`);
  for (const [k, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`# cpu ${name} self ${(ms / 1000).toFixed(2)} s ${k}`);
  for (const [k, ms] of [...incl].filter(([k]) => /apps\/|packages\//.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(`# cpu ${name} incl ${(ms / 1000).toFixed(2)} s ${k}`);
}
/** Summarize every child CPU profile in a directory, largest first. */
export function summarizeDir(name, directory) {
  let files = [];
  try { files = readdirSync(directory).filter(file => file.endsWith('.cpuprofile')); } catch { return; }
  const profiles = files.map(file => JSON.parse(readFileSync(join(directory, file), 'utf8'))).sort((a, b) => (b.endTime - b.startTime) - (a.endTime - a.startTime));
  console.log(`# cpu ${name}: ${profiles.length} child profiles, durations ${profiles.map(p => ((p.endTime - p.startTime) / 1e6).toFixed(1)).join(', ')} s`);
  if (profiles[0]) summarize(`${name}-main`, profiles[0]);
}
