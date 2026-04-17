import type * as TS from "typescript";

export const walkTs = (
  node: TS.Node,
  ts: typeof TS,
  visit: (current: TS.Node) => boolean | void,
): void => {
  const descend = visit(node);
  if (descend === false) return;
  ts.forEachChild(node, (child) => walkTs(child, ts, visit));
};
