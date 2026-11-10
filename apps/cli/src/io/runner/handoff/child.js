/** The runner's stage entry: reads one ticket request on stdin, runs the hand-off stages with the shared readers and prints the result as JSON [C7]. */
import { runHandoffStages } from '../../../../../runner/index.js';
import { handoffStageServices } from './services.js';

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { body += chunk; });
process.stdin.on('end', async () => {
  const { root, input, logFile } = JSON.parse(body);
  process.stdout.write(JSON.stringify(await runHandoffStages(root, input, { logFile, services: handoffStageServices() })));
});
