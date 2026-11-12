/** Watch mode attributes descendant output to the worker that started it [C7,V10]. */
import { test } from 'node:test';
import { runLegacy } from '../../fixtures/watchdog/legacy.js';

test('watch attributes descendant output to the correct worker [C7,V10]', t => runLegacy(t, 'watch'));
