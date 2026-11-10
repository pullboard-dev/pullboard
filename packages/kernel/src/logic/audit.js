/** Audit executions explicitly select real adapters locally and on remote runners [C7]. */
export function auditAdapterEnvironment(audit) {
  return audit ? { PULLBOARD_TEST_REAL: 'all', PULLBOARD_ADAPTER_AUDIT: '1' } : {};
}
