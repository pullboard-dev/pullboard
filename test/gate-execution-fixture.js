/** Bind test admission to the same real canonical providers as the production composition roots [C7]. */
import { runnerExecutionServices } from '../src/runners.js';
import { landingExecutionServices } from '../packages/landing/index.js';

export const executionServices = Object.freeze({ runners: runnerExecutionServices(), landing: landingExecutionServices() });

/** Generate literal provider imports beside a fixture's actual gate module, retaining its tooling version. */
export function executionServicesSource(gateURL) {
  // A fixture may name a gate cell module instead of a src/ one; the providers still sit in that tree's src/.
  const url = new URL(gateURL), cell = /^(.*)\/packages\/gate\/(?:index\.js|src\/shell\/[^/]+\.js)$/u.exec(url.pathname);
  const home = cell ? new URL(`${cell[1]}/src/`, url) : new URL('./', url);
  const runners = new URL('runners.js', home).href;
  const landing = new URL('landing-shards.js', home).href;
  return `import { runnerExecutionServices } from ${JSON.stringify(runners)};\nimport { landingExecutionServices } from ${JSON.stringify(landing)};\nconst executionServices = { runners: runnerExecutionServices(), landing: landingExecutionServices() };\n`;
}
