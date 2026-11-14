/** Pause only an owned fixture worker at a real landing side-effect boundary [B35]. */
const targets = {
  merging: ['packages/landing/src/io/step/merge.js', 'export async function mergeGroup(state, items) {'],
  gating: ['packages/landing/src/io/step/gate.js', "await save(state, { state: 'gating', tip: headCommit(state.batch.root), logPath });"],
  // A runner's land job, paused before it pushes the checked merge, and after it pushes and before it posts its receipt.
  pushing: ['packages/landing/src/io/runner/job.js', "const pushed = pushTrunk(root, { payload, trunk, base, remote, options: pushOptions() });"],
  recording: ['packages/landing/src/io/runner/job.js', "const receipt = await runLandingJob(claim.payload, { workdir, checks, renew, env, diagnose, pushOptions: () => permit ? permitPushOptions(permit) : [] });"],
  // A runner's land job, paused once its items are merged in the runner's checkout and before its check or push.
  'land-merge': ['packages/landing/src/io/runner/job.js', "if (pending.length === 0) return done('conflict');"],
};

/** Instrument the selected boundary without changing the checked-out source or any board records. */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const stage = process.env.PULLBOARD_PRIVATE_CRASH_STAGE;
  const target = targets[stage];
  if (!target || !url.endsWith('/' + target[0])) return result;
  const source = String(result.source);
  const needle = target[1];
  if (!source.includes(needle)) throw new Error('landing crash boundary moved: ' + stage);
  const pause = `__landingCrashPause();`;
  const after = ['merging', 'gating', 'land-merge', 'recording'].includes(stage);
  const patched = source.replace(needle, after ? needle + pause : pause + needle);
  const prefix = `import { writeFileSync as __landingCrashWrite } from 'node:fs';
/** Handshake the exact owned PID, then hold until its parent fixture kills it. */
function __landingCrashPause() {
  __landingCrashWrite(process.env.PULLBOARD_PRIVATE_CRASH_MARKER, JSON.stringify({ pid: process.pid, stage: ${JSON.stringify(stage)} }));
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
`;
  return { ...result, source: prefix + patched };
}
