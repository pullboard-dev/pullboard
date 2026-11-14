/** Exercise the native train producer, ordered landing writer and additive push check [C7]. */
import { test } from 'node:test';

test('native land retains one batch identity and records its actual envelope receipt before merged events [C7,B3]', { skip: 'CONTROLLER_ONLY: deleted with #6813 (the host batch step; pulled landing returns an offer and the runner posts the receipt)' }, () => {});
