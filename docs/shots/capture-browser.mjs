/** Real Chrome capture with explicit document and data readiness (I13,A10). */
import { writeFile } from 'node:fs/promises';
import { startChrome } from '../../apps/cli/tests/fixtures/chrome.js';

/** Start Chrome with a disposable profile and return the DevTools connection for its page. */
export async function browser(chrome, profile, url) {
  const printedUrl = new URL(url);
  const cleanEntry = printedUrl.origin !== 'null' && printedUrl.pathname === '/' && (printedUrl.search || printedUrl.hash)
    ? new URL('/', printedUrl.origin).href : url;
  const view = await startChrome({ executable: chrome, profileDirectory: profile, url });
  /** Keep this capture's readiness label while using the shared bounded DevTools wait. */
  async function waitFor(expression, label, timeoutMs = 30_000) {
    try { await view.waitFor(expression, timeoutMs); }
    catch (error) { throw new Error(`The demo page did not become ready: ${label}`, { cause: error }); }
  }
  try {
    await waitFor(`(location.href === ${JSON.stringify(url)} || location.href === ${JSON.stringify(cleanEntry)}) && document.readyState === 'complete'`, 'intended HTTP document');
  } catch (error) {
    await view.close();
    throw error;
  }
  return {
    evaluate: view.evaluate,
    waitFor,
    viewport: (width, height) => view.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
    screenshot: async (path) => { const result = await view.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path, Buffer.from(result.data, 'base64')); },
    close: () => view.close(),
  };
}

/** Wait for this demo's API data and rendered controls before storage writes or selection. */
export async function waitForDemoBoard(view, repo) {
  const ready = `typeof data !== 'undefined' && data?.project?.root === ${JSON.stringify(repo)} && data.root === view.root && view.tab === 'items' && data.projects.some(project => project.root === ${JSON.stringify(repo)} && project.ok && project.name === 'Demo board') && data.project.items.some(item => item.id === 1 && item.title === 'Reviewed and accepted') && !!document.querySelector('#filter-toggle')`;
  await view.waitFor(ready, 'addressed demo board, reviewed item summary and current Filter control');
}
