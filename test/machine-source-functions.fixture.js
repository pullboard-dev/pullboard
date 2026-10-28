import { posix } from 'node:path';
/** A top-level function, or a top-level arrow function bound to a const. */
const START = /^(?:export )?(?:(?:async )?function (\w+)\(|const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>)/;

/**
 * Each top-level function's source by name, arrow functions included. A function declaration ends
 * at its closing brace; an arrow function ends where its statement does.
 *
 * @param {string} source
 * @returns {Map<string, string>}
 */
export function functionsIn(source) {
  const bodies = new Map();
  let open = null;
  for (const line of source.split('\n')) {
    if (open) {
      open.lines.push(line);
      if (open.ends(line)) {
        bodies.set(open.name, open.lines.join('\n'));
        open = null;
      }
      continue;
    }
    const start = START.exec(line);
    if (!start) continue;
    const end = line.trimEnd();
    if (start[1] && end.endsWith('}')) bodies.set(start[1], line);
    else if (start[1]) open = { name: start[1], lines: [line], ends: (next) => next === '}' };
    else if (end.endsWith(';')) bodies.set(start[2], line);
    else if (end.endsWith('{')) open = { name: start[2], lines: [line], ends: (next) => next === '};' };
    else open = { name: start[2], lines: [line], ends: (next) => next.trimEnd().endsWith(';') };
  }
  return bodies;
}


/** Read one source identity and preserve named import/re-export and public star-provider edges. */
export function sourceFacts(read, file) {
  const source = read(file), named = new Map();
  /** Resolve literal relative operands against the actual provider's repository layout. */
  const under = (specifier) => posix.normalize(posix.join(posix.dirname(file), specifier));
  for (const [, names, , specifier] of source.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*(['"])(\.{1,2}\/[^'"]+\.js)\2/g)) {
    for (const part of names.split(',').map(text => text.trim()).filter(Boolean)) {
      const [original, local = original] = part.split(/\s+as\s+/);
      named.set(local, `${under(specifier)}#${original}`);
    }
  }
  const spaces = new Map([...source.matchAll(/import \* as (\w+) from (['"])(\.{1,2}\/[^'"]+\.js)\2/g)]
    .map(([, space, , specifier]) => [space, under(specifier)]));
  const stars = [...source.matchAll(/export\s*\*\s*from\s*(['"])(\.{1,2}\/[^'"]+\.js)\1/g)]
    .map(([, , specifier]) => under(specifier));
  return { bodies: functionsIn(source), named, spaces, source, stars };
}
