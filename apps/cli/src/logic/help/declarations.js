/** Ordered command-group declarations; separators remain part of their original text. */
import { introHelp } from './intro.js';
import { outsideHelp } from './outside.js';
import { setupHelp } from './setup.js';
import { workHelp } from './work.js';
import { coordinatorHelp } from './coordinator.js';
import { receiptsHelp } from './receipts.js';
import { specHelp } from './spec.js';
import { rolesHelp } from './roles.js';
import { gateHelp } from './gate.js';
import { lifecycleHelp } from '../../../../../packages/state/index.js';
import { footerHelp } from './footer.js';

export const HELP_SOURCE_SECTIONS = Object.freeze([
  Object.freeze({ name: 'intro', text: introHelp }),
  Object.freeze({ name: 'outside', text: outsideHelp }),
  Object.freeze({ name: 'setup', text: setupHelp }),
  Object.freeze({ name: 'work', text: workHelp }),
  Object.freeze({ name: 'coordinator', text: coordinatorHelp }),
  Object.freeze({ name: 'receipts', text: receiptsHelp }),
  Object.freeze({ name: 'spec', text: specHelp }),
  Object.freeze({ name: 'roles', text: rolesHelp }),
  Object.freeze({ name: 'gate', text: gateHelp }),
  Object.freeze({ name: 'lifecycle', text: lifecycleHelp }),
  Object.freeze({ name: 'footer', text: footerHelp }),
]);

