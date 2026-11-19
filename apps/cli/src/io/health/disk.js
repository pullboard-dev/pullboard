/** The free-disk warning behind health.diskFloorGb [C7,#9110]. */
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const GB = 2 ** 30;

/**
 * Say whether free disk on the volume holding `root` has dropped below the floor.
 * Why: a full disk stops every board write (the 16 Nov incident), and a warning comes while there is still room to act. Warn only, never refuse.
 * @param {string} root the board host's repository root
 * @param {number} floorGb the floor in gigabytes; 0 or less turns the check off
 * @param {Function} [statfs] the file system reader, replaceable in tests
 * @returns {{ freeGb: number, floorGb: number, line: string }|null} the finding, or null when disk is fine, the check is off or unreadable
 */
export function diskFloorFinding(root, floorGb, statfs = fileSystemAdapter().statfs) {
  if (!(floorGb > 0)) return null;
  let free;
  try { const stat = statfs(root); free = stat.bavail * stat.bsize; } catch { return null; }
  const freeGb = free / GB;
  if (freeGb >= floorGb) return null;
  const show = number => (Math.round(number * 10) / 10).toString();
  return { freeGb, floorGb, line: `low disk: ${show(freeGb)} GB free on this board host, under the ${show(floorGb)} GB floor (health.diskFloorGb); free space before the board stops writing` };
}
