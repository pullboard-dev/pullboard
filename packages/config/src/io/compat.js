/** Ignore future coordinator setting keys without relaxing any known value validator [N26]. */
const noted = new Set();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = names => Object.fromEntries(names.map(name => [name, null]));

/** The schema belongs to this validator version, never to the configuration being read. */
function schema(base) {
  const shape = value => object(value) && Object.keys(value).length
    ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shape(entry)])) : null;
  return {
    ...shape(base),
    submit: { ...shape(base.submit), ...fields(['handoff']) },
    seat: fields(['checkpoints']),
    spec: fields(['file', 'agentApproval']),
    flakes: fields(['rerun', 'quarantine']),
    rigor: fields(['budget', 'autoDraft']),
    cells: fields(['cache', 'shimMaxAgeDays', 'plan']),
    relay: fields(['outbox', 'board']),
    checks: fields(['provesNothing']),
    withdraw: fields(['review', 'refuseLanded']),
    release: fields(['liftTwiceHold']),
    claims: { ...shape(base.claims), ...fields(['perSeat', 'fileLease', 'fileLeaseHubs']) },
    jobs: fields(['expediteMax']),
    queue: fields(['contention', 'contentionThreshold']),
    inbox: { tokenBudget: null, keepUntilActed: null, escalateAfterMinutes: null, batchedMarks: null },
    publish: fields(['pullRequest']),
    pushReceiptCheck: fields(['smoke']),
    landing: { ...fields(['publish', 'timeout', 'stall', 'parallel', 'requireReceipts', 'pauseOnRed', 'manualOverride', 'perItem', 'shardProof', 'pipeline', 'landedFromMain', 'exactTreeCheck', 'sprintBarTests', 'ledgerMainReds', 'priorityOrder', 'first', 'auditOnly', 'splitRed', 'trunkRemote']),
      environment: fields(['platform', 'arch', 'node']), cadence: fields(['every', 'accepted']) },
    verify: { ...shape(base.verify), ...fields(['unrelatedTrunkMoves', 'composeAtAdmission', 'familyRelaxAt', 'landedReviews', 'queueAccept', 'reviewFolder', 'requireRowRewrite']) },
    resume: fields(['adoptOrphans']),
    ...fields(['project', 'name', 'submitGate', 'submitDeferAbove', 'confinedImportSelection', 'landingShards', 'positiveControl',
      'affectedTests', 'affectedSuites', 'approvers', 'maintainers', 'sandbox', 'intake', 'testConcurrency', 'health', 'specBoards', 'generated', 'laneMode', 'tiers']),
    tiers: Object.fromEntries(['routine', 'standard', 'escalation'].map(name => [name, fields(['endpoint', 'model'])])),

    testConcurrency: fields(['files', 'browser']),
    health: fields(['sentinel', 'stuck', 'holds', 'release', 'dependencyIdle']),
  };
}

/** Retain malformed known values verbatim so the ordinary validator still refuses them. */
export function knownConfigKeys(raw, base) {
  const visit = (value, allowed, path = []) => {
    if (!object(value) || !allowed) return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
      const parts = [...path, key];
      if (!Object.hasOwn(allowed, key)) {
        const label = parts.map(part => JSON.stringify(part)).join('.');
        if (!noted.has(label)) {
          noted.add(label);
          process.stderr.write(`pullboard: ignoring unknown setting key ${JSON.stringify(key)} at ${label} in this validator version\n`);
        }
        return [];
      }
      return [[key, visit(entry, allowed[key], parts)]];
    }));
  };
  return visit(raw, schema(base));
}
