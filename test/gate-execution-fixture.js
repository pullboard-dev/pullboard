/** Bind test admission to the same real canonical providers as the production composition roots [C7]. */
import { runnerExecutionServices } from '../packages/runners/index.js';
import { landingExecutionServices } from '../packages/landing/index.js';

export const executionServices = Object.freeze({ runners: runnerExecutionServices(), landing: landingExecutionServices() });

/** Generate literal provider imports beside a fixture's actual gate module, retaining its tooling version. */
export function executionServicesSource(gateURL) {
  const url = new URL(gateURL);
  const door = url.pathname.endsWith('/packages/gate/index.js');
  const moved = url.pathname.endsWith('/packages/gate/src/shell/gate.js');
  const runners = new URL(door ? '../runners/index.js' : moved ? '../../../runners/index.js' : './runners.js', gateURL).href;
  const landing = new URL(door ? '../landing/index.js' : moved ? '../../../landing/index.js' : './landing-shards.js', gateURL).href;
  return `import { runnerExecutionServices } from ${JSON.stringify(runners)};\nimport { landingExecutionServices } from ${JSON.stringify(landing)};\nconst executionServices = { runners: runnerExecutionServices(), landing: landingExecutionServices() };\n`;
}
