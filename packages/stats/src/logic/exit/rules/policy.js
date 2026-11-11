import ceilings from '../../../../data/context-ceilings.json' with { type: 'json' };

/** Pure exit decisions use known claim counters and exact consecutive receipt failures [B3,C7,N2]. */
/** An unavailable or malformed count is unknown, never a reason to stop a session. */
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

/** Identify a repeated native case only when both consecutive receipts actually failed that file and name. */
export function repeatedExitFailure(receipts) {
  if (!Array.isArray(receipts) || receipts.length < 2) return null;
  const [before, after] = receipts.slice(-2);
  if (before.id === after.id || before.exitCode !== 1 || after.exitCode !== 1
    || !Array.isArray(before.failures) || !Array.isArray(after.failures)) return null;
  for (const current of after.failures) {
    if (typeof current?.file !== 'string' || !current.file || typeof current?.name !== 'string' || !current.name) continue;
    if (before.failures.some(previous => previous?.file === current.file && previous?.name === current.name))
      return { file: current.file, name: current.name, receipts: [before.id, after.id] };
  }
  return null;
}

/** Never infer an overrun from missing provider data or let default-off policy change an existing session. */
export function exitRulesDecision(policy, usage, receipts = []) {
  if (policy?.enabled !== true) return null;
  const tokens = count(usage?.tokens), calls = count(usage?.calls);
  if (tokens !== null && tokens >= policy.tokens || calls !== null && calls >= policy.calls)
    return { code: 'EXIT_BUDGET', tokens, calls };
  const failure = repeatedExitFailure(receipts);
  return failure ? { code: 'EXIT_REPEAT_FAILURE', failure } : null;
}

/** The prompt size at which a session ends: exitRules.contextCeiling, else the per-family ceiling from packages/stats/data/context-ceilings.json [P5]. */
export function contextCeiling(policy, model) {
  if (Number.isSafeInteger(policy?.contextCeiling) && policy.contextCeiling > 0) return policy.contextCeiling;
  const name = String(model ?? '').toLowerCase();
  return ceilings.families.find(family => name.includes(family.contains))?.ceiling ?? ceilings.default;
}

/** A seat whose last call's prompt exceeds the ceiling ends after its claim settles; unknown usage never ends a session [C7]. */
export function exitContextDecision(policy, last) {
  if (policy?.enabled !== true || !last || !Number.isSafeInteger(last.tokens) || last.tokens < 0) return null;
  const ceiling = contextCeiling(policy, last.model);
  return last.tokens > ceiling ? { code: 'EXIT_CONTEXT', context: last.tokens, ceiling } : null;
}
