/** Bind test admission to the same real canonical providers as the production composition roots [C7]. */
import { runnerExecutionServices } from '../src/runners.js';
import { landingExecutionServices } from '../src/landing-shards.js';

export const executionServices = Object.freeze({ runners: runnerExecutionServices(), landing: landingExecutionServices() });

/** Generate literal provider imports beside a fixture's actual gate module, retaining its tooling version. */
export function executionServicesSource(gateURL) {
  const runners = new URL('./runners.js', gateURL).href;
  const landing = new URL('./landing-shards.js', gateURL).href;
  return `import { runnerExecutionServices } from ${JSON.stringify(runners)};\nimport { landingExecutionServices } from ${JSON.stringify(landing)};\nconst executionServices = { runners: runnerExecutionServices(), landing: landingExecutionServices() };\n`;
}
