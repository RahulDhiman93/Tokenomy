import type * as TS from "typescript";

export const scriptKindFor = (path: string, ts: typeof TS): TS.ScriptKind => {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
};
