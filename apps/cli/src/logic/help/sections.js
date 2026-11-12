/** Compose source-owned groups with the generated browser-safe command extension [C7,N26]. */
import { HELP_SOURCE_SECTIONS } from './declarations.js';
import { additionsHelp } from './additions.js';

export const HELP_SECTIONS = Object.freeze(HELP_SOURCE_SECTIONS.flatMap(section => section.name === 'footer'
  ? [Object.freeze({ name: 'additions', text: additionsHelp }), section] : [section]));

export const ALL_HELP = HELP_SECTIONS.map(section => section.text).join('');
