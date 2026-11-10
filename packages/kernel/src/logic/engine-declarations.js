/** Exact reserved-engine binding classifier without filesystem or lexical-provider imports [C7,CD64]. */
/** Read variable binding patterns, skipping initializer expressions so references remain allowed. */
export function engineBindings(code) {
  const tokens = [...code.matchAll(/"[^"]*"|'[^']*'|[\p{ID_Start}_$][\p{ID_Continue}$]*|[0-9][\w.]*|\.\.\.|[^\s]/gu)];
  const found = new Map();
  /** Skip an expression through its next declaration or binding separator. */
  function expression(at, ends) {
    const stack = [];
    for (; at < tokens.length; at++) {
      const word = tokens[at][0];
      if (!stack.length && ends.includes(word)) break;
      if ('([{'.includes(word)) stack.push(word);
      else if (')]}'.includes(word)) { if (!stack.length) break; stack.pop(); }
    }
    return at;
  }
  /** Remember a reserved name only when it is the binding, never an object property key. */
  function name(at) {
    if (/^[A-Z][A-Z0-9_]*_ENGINE$/u.test(tokens[at]?.[0] ?? '')) found.set(tokens[at].index, tokens[at]);
  }
  /** Walk identifiers, arrays and nested object aliases in one binding pattern. */
  function binding(at) {
    if (tokens[at]?.[0] === '...') return binding(at + 1);
    const open = tokens[at]?.[0];
    if (open !== '{' && open !== '[') { name(at); return at + 1; }
    const close = open === '{' ? '}' : ']';
    at++;
    while (at < tokens.length && tokens[at][0] !== close) {
      if (tokens[at][0] === ',') { at++; continue; }
      if (open === '{' && tokens[at][0] !== '...') {
        const key = at;
        at = tokens[at][0] === '[' ? expression(at + 1, [']']) + 1 : at + 1;
        if (tokens[at]?.[0] === ':') at = binding(at + 1);
        else name(key);
      } else at = binding(at);
      if (tokens[at]?.[0] === '=') at = expression(at + 1, [',', close]);
      if (tokens[at]?.[0] === ',') at++;
      else if (tokens[at]?.[0] !== close) break;
    }
    return at + 1;
  }
  for (let at = 0; at < tokens.length; at++) {
    if (!['const', 'let', 'var'].includes(tokens[at][0])) continue;
    let next = at + 1;
    do {
      next = binding(next);
      if (tokens[next]?.[0] === '=') next = expression(next + 1, [',', ';', ')']);
      if (tokens[next]?.[0] !== ',') break;
      next++;
    } while (next < tokens.length);
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}

