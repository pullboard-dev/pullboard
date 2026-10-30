/** Select genuine repeated Submit contradictions without lending skips or deterministic reds authority [C7,H16]. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Return at most one ordered same-tree red/pass pair from each distinct native Submit admission within 24 hours. */
export function submitFlakePairs(runs, file, name, at) {
  const end = Date.parse(at), admissions = new Map();
  if (!Number.isFinite(end)) return [];
  for (const run of runs) {
    const proof = run.proof, time = Date.parse(run.at);
    const outcome = run.testOutcomes?.find(row => row.file === file && row.name === name);
    const diagnostic = run.kind === 'check' && proof?.submitPhase === 'diagnostic' && proof.frozenDigest === null;
    if (!(run.kind === 'submit' || diagnostic) || run.version !== 2 || proof?.sourceClean !== true
      || ![0, 1].includes(proof.exitCode) || !proof.submitAdmission || !run.tree
      || !Number.isFinite(time) || time > end || time < end - DAY_MS || !outcome || outcome.skipped) continue;
    // Each pair keeps its own tree and actor/item; unrelated phases cannot complete another submit's evidence.
    const key = JSON.stringify([proof.submitAdmission, proof.seat, proof.item, run.tree]);
    const group = admissions.get(key) ?? [];
    if (!group.some(entry => entry.run.id === run.id)) group.push({ run, time, passed: outcome.passed, diagnostic });
    admissions.set(key, group);
  }
  const pairs = new Map();
  for (const group of admissions.values()) {
    group.sort((a, b) => a.time - b.time);
    const red = group.find(entry => !entry.passed && !entry.diagnostic);
    const green = red && group.find(entry => entry.passed && entry.diagnostic && entry.time > red.time);
    if (green && !pairs.has(red.run.proof.submitAdmission)) pairs.set(red.run.proof.submitAdmission, [red.run, green.run]);
  }
  return [...pairs.values()];
}
