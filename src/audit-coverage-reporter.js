/** Observe real Node branch coverage; this reporter never interprets test stdout as coverage [C7]. */
/** Consume the native event stream alongside TAP, retaining runtime and audited working directory. */
export default async function* auditCoverage(events) {
  for await (const event of events) if (event.type === 'test:coverage') {
    yield '# pullboard-audit-coverage ' + JSON.stringify({ runtime: process.version, summary: event.data.summary }) + '\n';
  }
}
