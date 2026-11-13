/** Explicit result bindings for item-creating moves; input item fields never become created-item identities [B26,H16]. */
const SINGLE = Object.freeze({ recordSelectorGap: ['item'], addItem: [], requestCompanion: ['item'], createItemSlice: ['item'], intakeOutside: [], openHandoff: ['item'],
  recordLandingFlake: ['item'], recordLandingTestDefect: ['item'], recordFlakeObservation: ['item'],
  recordPublishFinding: ['repair'] });

/** Whether this operation can return new item identities, including an empty or refused result. */
export function createsItems(operation) {
  return Object.hasOwn(SINGLE, operation) || operation === 'recordGateRun' || operation === 'submit';
}

/** Read a declared result path; multi-repair identities follow their file/name rather than a changing array index. */
export function createdItemAt(result, path) {
  return path.reduce((value, key) => typeof key === 'object'
    ? Array.isArray(value) ? value.find(row => row.file === key.file && row.name === key.name) : undefined
    : value?.[key], result);
}

/** Project only declared created results; publication's original item is deliberately not its repair. */
export function createdItems(operation, result) {
  if (operation === 'recordSelectorGap' && result?.filed !== true) return [];
  const paths = Object.hasOwn(SINGLE, operation) ? [SINGLE[operation]] : operation === 'recordGateRun'
    ? (result?.quarantined ?? []).map(row => ['quarantined', { file: row.file, name: row.name }, 'item'])
    : operation === 'submit' ? (result?.mainRedRepairs ?? []).map(row => ['mainRedRepairs', { file: row.file, name: null }, 'item']) : [];
  return paths.map(resultPath => ({ resultPath, item: createdItemAt(result, resultPath) }))
    .filter(row => Number.isSafeInteger(row.item) && row.item > 0);
}

/** Read new per-result bindings or the original single numeric addItem entry without rewriting stored history. */
export function entryCreatedItems(entry) {
  return Array.isArray(entry.created) ? entry.created
    : Number.isSafeInteger(entry.visible) ? [{ resultPath: [], item: entry.visible }] : [];
}

/** Remember the local result after both initial application and a partial replay's rebase. */
export function rememberCreatedItems(entry, result) {
  if (!createsItems(entry.move.operation)) return;
  if (entry.move.operation === 'submit' && !Array.isArray(result?.mainRedRepairs)) return;
  entry.created = createdItems(entry.move.operation, result);
  if (entry.move.operation === 'addItem' && Number.isSafeInteger(result)) entry.visible = result;
}
