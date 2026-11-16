import { test } from 'node:test';
import { spawn } from 'node:child_process';
test('probe [C7]', async () => {
  const p = spawn('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', 'apps/cli/journeys/release/size-claim.test.js,apps/cli/journeys/release/size-take.test.js,apps/cli/journeys/release/size-verify.test.js,apps/cli/journeys/reopen/evidence.test.js']);
  let buf = '';
  const emit = (s) => { buf += s; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) if (/^(# )?(hold|unmeasured|convert|\d+ of)/.test(l.trim())) console.log('JCV ' + l); };
  p.stdout.on('data', (d) => emit(String(d)));
  p.stderr.on('data', (d) => emit(String(d)));
  await new Promise((r) => p.on('close', r));
});
