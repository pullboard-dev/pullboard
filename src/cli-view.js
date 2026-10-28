/** Compose the view with the actual CLI command and page renderer [N26,C7]. */
import { main } from './cli-main.js';
import { cockpitPage } from './cockpit.js';
import { exportView as exportProvidedView } from './serve.js';
import { serveView as serveProvidedView } from './serve.js';

/** Serve the local page with the CLI authority supplied by its higher-level caller. */
export function serveView(options = {}) {
  return serveProvidedView({ ...options, runCommand: main, renderPage: cockpitPage });
}

/** Export the page with the same command authority and renderer used by the live view. */
export function exportView(root, directory, options = {}) {
  return exportProvidedView(root, directory, { ...options, runCommand: main, renderPage: cockpitPage });
}

// The checked exporter owns this capability; the composition preserves its public-export guard.
exportView.supportsPublicExport = exportProvidedView.supportsPublicExport;
