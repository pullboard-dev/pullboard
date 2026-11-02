/** Observed per-file collision pressure, Little's law and chronological validation [R1,R2]. */
const HOUR = 3_600_000;

/** Missing measurements remain null, including division by an unobserved denominator. */
function ratio(numerator, denominator) { return denominator > 0 ? numerator / denominator : null; }

/** Average only a complete population, so missing old claim boundaries cannot look like zero wait. */
function completeMean(rows, key) {
  return rows.length && rows.every(row => Number.isFinite(row[key]) && row[key] >= 0)
    ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : null;
}

/** Measure one half-open interval without dropping large changes or unclassified conflict files. */
function period(landings, conflicts, from, to) {
  const landed = landings.filter(row => row.at >= from && row.at < to);
  const collided = conflicts.filter(row => row.at >= from && row.at < to);
  const touches = new Map(), counts = new Map();
  for (const row of landed) for (const file of new Set(row.files ?? [])) touches.set(file, (touches.get(file) ?? 0) + 1);
  for (const row of collided) for (const file of new Set(row.files ?? [])) counts.set(file, (counts.get(file) ?? 0) + 1);
  const hours = (to - from) / HOUR;
  const landingRate = landed.length / hours;
  const lifetimeHours = completeMean(landed, 'lifetimeHours');
  const buildHours = completeMean(landed, 'buildHours');
  const waitingHours = completeMean(landed, 'waitingHours');
  const cellsPerItem = landed.length && landed.every(row => Array.isArray(row.files)) ? landed.reduce((sum, row) =>
    sum + new Set(row.files.map(file => /^(apps|packages)\/([^/]+)\//u.exec(file)).filter(Boolean).map(match => `${match[1]}/${match[2]}`)).size, 0) / landed.length : null;
  const inFlight = lifetimeHours === null ? null : landingRate * lifetimeHours;
  const completeFiles = landed.every(row => Array.isArray(row.files)) && collided.every(row => Array.isArray(row.files));
  const files = [...new Set([...touches.keys(), ...counts.keys()])].sort().map(file => {
    const touch = touches.get(file) ?? 0;
    const share = ratio(touch, landed.length);
    const sharedTouches = inFlight === null || share === null ? null : touch * inFlight * share;
    return { file, touches: touch, conflicts: counts.get(file) ?? 0, share, sharedTouches };
  });
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), landings: landed.length,
    conflicts: collided.length, conflictsPerLanding: ratio(collided.length, landed.length), landingRate,
    lifetimeHours, buildHours, waitingHours, inFlight,
    buildingInFlight: buildHours === null ? null : landingRate * buildHours,
    waitingInFlight: waitingHours === null ? null : landingRate * waitingHours,
    cellsPerItem, files, completeFiles,
    missing: { landingFiles: landed.filter(row => !Array.isArray(row.files)).length,
      conflictFiles: collided.filter(row => !Array.isArray(row.files)).length,
      lifetimes: landed.filter(row => !Number.isFinite(row.lifetimeHours)).length } };
}

/** Fit the source study's two-shared-touch shrinkage, with every calibration assumption printed. */
function fit(sample) {
  const exposure = sample.files.reduce((sum, row) => sum + (row.sharedTouches ?? 0), 0);
  const mentions = sample.files.reduce((sum, row) => sum + row.conflicts, 0);
  const available = sample.completeFiles && sample.lifetimeHours !== null && exposure > 0;
  const globalRate = available ? mentions / exposure : null;
  const files = sample.files.map(row => {
    const rate = available ? (row.conflicts + 2 * globalRate) / (row.sharedTouches + 2) : null;
    return { ...row, rate, pressure: rate === null || row.share === null ? null : rate * row.share ** 2 };
  }).sort((a, b) => (b.pressure ?? -1) - (a.pressure ?? -1) || a.file.localeCompare(b.file));
  const eventPerMention = mentions > 0 ? sample.conflicts / mentions : sample.conflicts === 0 ? 1 : null;
  const k = available && eventPerMention !== null ? files.reduce((sum, row) => sum + row.pressure, 0) * eventPerMention : null;
  return { ...sample, files, globalRate, k, eventPerMention,
    agentsAtFivePercent: k > 0 ? 1 + 0.05 / k : null,
    peakAgents: k > 0 ? 1 / (2 * k) : null, peakOutput: k > 0 ? 1 / (4 * k) : null };
}

/** Fit the first half only; use test-period exposure to predict its held-out file-conflict count. */
export function carryingCapacity({ landings = [], conflicts = [], from, to }) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new TypeError('capacity needs an increasing finite window');
  const middle = start + (end - start) / 2;
  const whole = fit(period(landings, conflicts, start, end));
  const training = fit(period(landings, conflicts, start, middle));
  const heldOut = period(landings, conflicts, middle, end);
  const rates = new Map(training.files.map(row => [row.file, row.rate]));
  const actual = heldOut.files.reduce((sum, row) => sum + row.conflicts, 0);
  const predicted = training.globalRate !== null && heldOut.completeFiles && heldOut.lifetimeHours !== null
    ? heldOut.files.reduce((sum, row) => sum + (rates.get(row.file) ?? training.globalRate) * row.sharedTouches, 0) : null;
  return { version: 1, ...whole, validation: { trainingFrom: training.from, trainingTo: training.to,
    heldOutFrom: heldOut.from, heldOutTo: heldOut.to, trainingLandings: training.landings,
    heldOutLandings: heldOut.landings, actualFileConflicts: actual, predictedFileConflicts: predicted,
    error: predicted === null ? null : predicted - actual,
    relativeError: predicted === null || actual === 0 ? null : (predicted - actual) / actual },
    assumptions: ['Shared touches are estimated as file touches × measured changes in flight × file share.',
      'Per-file rates shrink toward the global rate by two estimated shared touches, following the source study.',
      'k converts file mentions to conflict events using the measured event/mention ratio.',
      'The peak formulas are model approximations, not measured machine capacity or a staffing instruction.',
      'Missing measurements and zero-pressure finite ceilings are unknown; no historical notes are parsed as typed conflicts.'] };
}
