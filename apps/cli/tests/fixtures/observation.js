/** Synthetic receipt metadata for public format/credential contracts; no test execution is claimed. */
import { createHash } from 'node:crypto';

/** Make a bounded synthetic observation; confirmed values exercise the repair-link event contract. */
export function syntheticFlakeObservation(id, confirmed = false) {
  const receipt = green => {
    const body = Buffer.from(green ? 'synthetic paired receipt' : 'synthetic original receipt');
    return { green, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length,
      artifact: 'flake-evidence/' + id + '/' + (green ? 'paired' : 'original') + '.log', profileSha256: null };
  };
  return { id, file: 'test/synthetic.test.js', name: 'synthetic contract target', head: 'a'.repeat(40), tree: 'b'.repeat(40), main: 'a'.repeat(40),
    kind: 'check', classification: confirmed ? 'flake' : 'unclassified', reason: 'Synthetic contract metadata only; no gate run is claimed.',
    commandSha256: 'c'.repeat(64), at: '2026-10-20T00:00:00.000Z', diagnosticMs: 0,
    load: { average: [0, 0, 0], cpus: 1, freeMB: 100 }, original: receipt(false), paired: confirmed ? receipt(true) : null, mainReceipt: null };
}
