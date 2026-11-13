/** Bind test admission to the same real canonical providers as the production composition roots [C7]. */
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';

export const executionServices = Object.freeze({ runners: runnerExecutionServices(), landing: landingExecutionServices() });

/** Generate literal provider imports beside a fixture's actual gate module, retaining its tooling version. */
export function executionServicesSource(gateURL) {
  const root = new URL(gateURL);
  const entry = /\/(?:src\/[^/]+\.js|packages\/gate\/(?:index\.js|src\/(?:io|shell)\/.+\.js))$/u.exec(root.pathname);
  if (!entry) throw new Error('gate fixture needs an exact canonical gate entry');
  root.pathname = root.pathname.slice(0, entry.index + 1);
  const runners = new URL('packages/runners/index.js', root).href;
  const landing = new URL('packages/landing/index.js', root).href;
  return `import { runnerExecutionServices } from ${JSON.stringify(runners)};\nimport { landingExecutionServices } from ${JSON.stringify(landing)};\nconst executionServices = { runners: runnerExecutionServices(), landing: landingExecutionServices() };\n`;
}

/** Exercise two real gates and their empty single-slot queue in one watchdog-owned worker [Q4,C7]. */
export function redGateReleaseSource() {
  const root = new URL('../../../../../', import.meta.url);
  const GATE_MODULE = new URL('packages/gate/index.js', root).href;
  return `
    import assert from 'node:assert/strict';
    import { runGate } from ${JSON.stringify(new URL('packages/gate/index.js', root).href)};
    import { setGateSlots } from ${JSON.stringify(new URL('packages/config/index.js', root).href)};
    import { listResources } from ${JSON.stringify(new URL('packages/resources/index.js', root).href)};
${executionServicesSource(GATE_MODULE)}
    // Exercise the canonical settings writer in this same bounded worker, without booting another CLI.
    setGateSlots(1);
    const first = await runGate(process.cwd(), { gate: process.argv[1] }, { executionServices, trustStamp: false });
    const released = listResources().find(resource => resource.name === 'gate');
    assert.equal(released.capacity, 1);
    assert.equal(released.holders.length, 0);
    assert.equal(released.line.length, 0);
    const second = await runGate(process.cwd(), { gate: process.argv[1] }, { executionServices, trustStamp: false });
    const finished = listResources().find(resource => resource.name === 'gate');
    assert.equal(finished.holders.length, 0);
    assert.equal(finished.line.length, 0);
    console.log(JSON.stringify({ firstGreen: first.isGreen, secondGreen: second.isGreen }));
  `;
}
