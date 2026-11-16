/** @pullboard-module-loads packages/runners/index.js */
import { copyRunnerPackage } from './package.js';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = fileURLToPath(new URL('../../../../', import.meta.url));

/** A committed private copy of the runner package, with its own tooling module loaded from that copy so its root is the copy. */
export async function committedTooling(t, graph) {
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  copyRunnerPackage(SOURCE, graph.root);
  graph.commit();
  const { trustedTooling } = await import(pathToFileURL(join(graph.root, 'packages/runners/index.js')).href);
  return { graph, trustedTooling };
}
