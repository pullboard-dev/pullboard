/** Typed landing fields require the engine that understands their hold and executor semantics. */
export function carriesLandingEnvironment(batch) {
  return ['environment', 'environmentWarnings', 'testDefects'].some(key => Object.hasOwn(batch ?? {}, key))
    || batch?.state === 'test-defect' || Array.isArray(batch?.gateResults) && batch.gateResults.some(gate => Object.hasOwn(gate ?? {}, 'environment'));
}


