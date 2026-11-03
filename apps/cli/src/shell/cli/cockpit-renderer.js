/** Compose the view with the CLI-owned command catalog rather than importing it from the view cell [N26,C7]. */
import { cockpitPage as renderPage } from '../cockpit.js';
import { commandPhrases } from '../../core/help.js';

/** Keep the existing prose inventory in the higher renderer that owns the command catalog. */
export const PULLBOARD_COMMANDS = Object.freeze(commandPhrases().sort((left, right) => right.split(' ').length - left.split(' ').length));

/** Bind the current catalog for local, relay and exported pages without giving the view a CLI dependency. */
export function cockpitPage(key = '', options = {}) {
  return renderPage(key, { ...options, commandPhrases });
}
