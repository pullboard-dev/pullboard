/** Compose the view with the CLI-owned command catalog rather than importing it from the view cell [N26,C7]. */
import { cockpitPage as renderPage } from '../cockpit.js';
import { commandPhrases } from '../../core/help.js';

/** Preserve the public catalog without reading help while the view's import cycle initializes. */
export { PULLBOARD_COMMANDS } from '../../core/help.js';

/** Bind the current catalog for local, relay and exported pages without giving the view a CLI dependency. */
export function cockpitPage(key = '', options = {}) {
  return renderPage(key, { ...options, commandPhrases });
}
