/** Read a JUnit XML report into case outcomes, with a coded reason instead of a throw on damaged XML [C7]. */

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };

/** Decode the five XML entities in an attribute value. */
function unescapeXml(text) {
  return text.replace(/&(?:lt|gt|quot|apos|amp);/gu, entity => ENTITIES[entity]);
}

/** The attributes of one tag's text as a name to value object. */
function attributes(tag) {
  const found = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) found[match[1]] = unescapeXml(match[2] ?? match[3]);
  return found;
}

/** Each testcase name with pass, fail or skip; damaged or empty XML gives no cases and a reason code, never a throw [C7]. */
export function junitCases(xml) {
  if (typeof xml !== 'string' || !/<(?:testsuites|testsuite)[\s>]/u.test(xml)) return { cases: [], reason: 'JUNIT_UNREADABLE' };
  const opens = (xml.match(/<testcase\b/gu) ?? []).length;
  const closes = (xml.match(/<\/testsuite>/gu) ?? []).length + (xml.match(/<testsuite\b[^>]*\/>/gu) ?? []).length;
  const suites = (xml.match(/<testsuite\b/gu) ?? []).length;
  if (suites > closes || opens === 0 && !/<testsuite\b/u.test(xml)) return { cases: [], reason: 'JUNIT_DAMAGED' };
  const cases = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/gu)) {
    const name = attributes(match[1]).name;
    if (name === undefined) return { cases: [], reason: 'JUNIT_DAMAGED' };
    const body = match[3] ?? '';
    const outcome = /<(?:failure|error)\b/u.test(body) ? 'fail' : /<skipped\b/u.test(body) ? 'skip' : 'pass';
    cases.push({ name, outcome });
  }
  if (opens !== cases.length) return { cases: [], reason: 'JUNIT_DAMAGED' };
  return { cases, reason: null };
}
