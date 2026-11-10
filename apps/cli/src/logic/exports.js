/** A public export runs only through an exporter that declares its checked public filter [N26]. */
import { Refused } from '../../../../packages/kernel/index.js';

/**
 * Refuse --public unless the exporter declares the checked filter, so an older build never writes private data
 * under a public label. Kept apart from commands/view.js so its test does not load the view's OS opener.
 * @param {{ supportsPublicExport?: boolean }} exporter
 */
export function assertPublicExportSupported(exporter) {
  if (exporter?.supportsPublicExport !== true) {
    throw new Refused('PUBLIC_EXPORT_UNAVAILABLE', 'public exports are unavailable in this build; upgrade Pullboard before using --public');
  }
}
