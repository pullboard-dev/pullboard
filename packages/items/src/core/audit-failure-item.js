/** Name every landing after the last green audit; a failed audit is not attributed to an arbitrary item. */
export function auditFailureItem({ failures, landings, sinceEventId = 0, lane }) {
  if (!failures.length) return null;
  const after = landings.filter(row => row.eventId > sinceEventId).map(row => ({ eventId: row.eventId, commit: row.commit, items: row.items }));
  return { lane, title: `Main red: scheduled audit (${failures.map(row => row.file).join(', ')})`,
    criterion: `The scheduled audit passes. Failures: ${failures.map(row => `${row.file}: ${row.name}`).join('; ')}. Landings since last green audit: ${JSON.stringify(after)}`,
    route: 'strong', audit: { sinceEventId, landings: after } };
}
