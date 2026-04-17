import { startGraphServer } from "../mcp/server.js";

export const runGraphServe = async (opts: { cwd: string; path?: string }): Promise<number> => {
  const target = opts.path ?? opts.cwd;
  await startGraphServer(target);
  return await new Promise<number>(() => {});
};
