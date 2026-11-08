/** Find the tests whose import closure holds a file the graph cannot resolve, in one pass over the graph [C7,V4]. */

/**
 * The tests whose root closure is incomplete: a test with an undeclared computed import, or one that reaches a file
 * marked unknown. One walk from the unknown files along reverse edges finds them all, so the cost is the graph's
 * edges once, not a closure per test. `reasonOf` names the first unresolved file the way a closure walk would.
 *
 * @param {{ paths: string[], reverse: Map<string, Set<string>>, unknown: Map<string, string>, undeclared: Map<string, string> }} graph
 * @param {(path: string) => boolean} isTest
 * @returns {{ has: (test: string) => boolean, reasonOf: (test: string) => string }}
 */
export function unknownRootTests(graph, isTest) {
  // An unreadable test is unknown to every test that imports it too, so the walk starts from both [C7].
  const reaching = new Set([...graph.unknown.keys(), ...graph.undeclared.keys()]);
  const queue = [...reaching];
  for (let at = 0; at < queue.length; at += 1) {
    for (const importer of graph.reverse.get(queue[at]) ?? []) if (!reaching.has(importer)) { reaching.add(importer); queue.push(importer); }
  }
  const has = test => graph.undeclared.has(test) || reaching.has(test);
  let forward;
  /** Walk one test's dependencies breadth first until the first unknown file, as the closure computation does. */
  function reasonOf(test) {
    if (graph.undeclared.has(test)) return graph.undeclared.get(test);
    if (!forward) {
      forward = new Map();
      for (const [dependency, importers] of graph.reverse) for (const importer of importers) {
        if (!forward.has(importer)) forward.set(importer, new Set());
        forward.get(importer).add(dependency);
      }
    }
    const reached = new Set([test]);
    const walk = [test];
    for (let at = 0; at < walk.length; at += 1) {
      const path = walk[at];
      if (graph.unknown.has(path)) return `${graph.unknown.get(path)} in reached file ${path}`;
      if (path !== test && graph.undeclared.has(path)) return `${graph.undeclared.get(path)} in reached file ${path}`;
      for (const dependency of forward.get(path) ?? []) if (!reached.has(dependency)) { reached.add(dependency); walk.push(dependency); }
    }
    return '';
  }
  return { has: test => isTest(test) && has(test), reasonOf };
}
