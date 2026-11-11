/** Repository selectors belong to the caller, never a test or gate's disposable Git work [C7]. */
const SELECTORS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']);

/** Clear selectors before discovery or child dispatch; diagnostics name keys and never reveal their values. */
export function removeGitRepositorySelectors(environment, report = null) {
  const removed = SELECTORS.filter(name => Object.hasOwn(environment, name));
  for (const name of removed) delete environment[name];
  if (removed.length && report) report(`pullboard: removed inherited Git selectors: ${removed.join(', ')}\n`);
  return removed;
}
