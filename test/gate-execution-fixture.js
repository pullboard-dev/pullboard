/** Bind test admission to the same real canonical providers as the production composition roots [C7]. */
import { runnerExecutionServices } from '../packages/runners/index.js';
import { landingExecutionServices } from '../packages/landing/index.js';

export const executionServices = Object.freeze({ runners: runnerExecutionServices(), landing: landingExecutionServices() });

/** Generate literal provider imports beside a fixture's actual gate module, retaining its tooling version. */
export function executionServicesSource(gateURL) {
  const root = new URL(gateURL);
  const entry = /\/(?:src\/[^/]+\.js|packages\/gate\/(?:index\.js|src\/shell\/[^/]+\.js))$/u.exec(root.pathname);
  if (!entry) throw new Error('gate fixture needs an exact canonical gate entry');
  root.pathname = root.pathname.slice(0, entry.index + 1);
  const runners = new URL('packages/runners/index.js', root).href;
  const landing = new URL('packages/landing/index.js', root).href;
  return `import { runnerExecutionServices } from ${JSON.stringify(runners)};\nimport { landingExecutionServices } from ${JSON.stringify(landing)};\nconst executionServices = { runners: runnerExecutionServices(), landing: landingExecutionServices() };\n`;
}
