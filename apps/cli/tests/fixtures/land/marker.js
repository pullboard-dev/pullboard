/** Shared marker observations for the real landing fixtures [B3,R3]. */
import { readFileSync } from 'node:fs';

export const MARKER_NOT_YET = Symbol('marker not yet written');

/** Read a complete marker, treating a missing or mid-write file as unpublished. */
export function readMarker(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return MARKER_NOT_YET;
    throw error;
  }
}

