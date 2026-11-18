/** Read the JUnit report a landing gate wrote, for the failure names landing records [C7]. */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { junitCases } from '../../../../gate/light.js';
import { junitFailures } from '../../logic/junit-failures.js';

/**
 * The text of the report at `path` (relative to the landing checkout) and a code when it cannot be used: JUNIT_UNREADABLE
 * for a missing, outside-the-checkout or non-XML file, JUNIT_DAMAGED for a cut one. Never throws.
 * When `path` is a folder, every *.xml one level down is read (Maven and Gradle write one file per class): the readable
 * reports are joined into one text and each unreadable one is named in `unreadable`, so one bad file never hides the rest.
 * Why: a missing or damaged report must fall back to the output parse, not fail the landing step by itself [C7].
 */
export function readJunitReport(root, path) {
  const file = resolve(root, path);
  const inside = relative(root, file);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return { xml: null, code: 'JUNIT_UNREADABLE' };
  let folder = false;
  try { folder = statSync(file).isDirectory(); } catch { return { xml: null, code: 'JUNIT_UNREADABLE' }; }
  if (folder) return readJunitFolder(file);
  let xml;
  try { xml = readFileSync(file, 'utf8'); } catch { return { xml: null, code: 'JUNIT_UNREADABLE' }; }
  const { code } = junitFailures(xml, root);
  return code ? { xml: null, code } : { xml, code: null };
}

/** The readable reports of a folder joined as one text, with the unreadable ones named; JUNIT_UNREADABLE when none read. */
function readJunitFolder(folder) {
  let names;
  try { names = readdirSync(folder).filter(name => name.endsWith('.xml')).sort(); } catch { return { xml: null, code: 'JUNIT_UNREADABLE' }; }
  const reports = [];
  for (const name of names) {
    let xml = null;
    try { xml = readFileSync(join(folder, name), 'utf8'); } catch { /* named below as unreadable */ }
    reports.push({ path: name, xml });
  }
  if (!reports.length) return { xml: null, code: 'JUNIT_UNREADABLE' };
  const bad = new Set(reports.filter(report => junitCases(report.xml).reason).map(report => report.path));
  const good = reports.filter(report => !bad.has(report.path));
  if (!good.length) return { xml: null, code: 'JUNIT_UNREADABLE', unreadable: [...bad] };
  return { xml: good.map(report => report.xml.replace(/^\s*<\?xml[^>]*\?>/u, '')).join('\n'), code: null, unreadable: [...bad] };
}
