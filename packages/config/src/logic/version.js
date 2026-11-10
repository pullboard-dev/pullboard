/** Keep the displayed version sourced from package metadata without a help cycle. */
import packageData from '../../../../package.json' with { type: 'json' };
export const VERSION = packageData.version;
