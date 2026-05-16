import { TOKENOMY_VERSION } from "../core/version.js";
import { stableStringify } from "../util/json.js";
import { dispatchGraphTool } from "./handlers.js";
import { markServerModeActive, registerRepo, stopAllWorkers } from "./rebuild-worker.js";
import { loadConfig } from "../core/config.js";
import { resolveRepoId } from "../graph/repo-id.js";
import { TOOL_DEFS } from "./schemas.js";

export const startGraphServer = async (cwd: string): Promise<void> => {
  const [{ Server }, { StdioServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);

  const server = new Server(
    { name: "tokenomy-graph", version: TOKENOMY_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await dispatchGraphTool(
      request.params.name,
      request.params.arguments ?? {},
      cwd,
    );
    return {
      content: [{ type: "text", text: stableStringify(result) }],
      isError: !result.ok,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 0.1.9+: register the rebuild worker for the host cwd. Additional
  // repos registered lazily inside `dispatchGraphTool` when the
  // `path` arg points at a different repo. Skipped silently when the
  // config disables it.
  markServerModeActive(true);
  try {
    // codex round 3 P3: load config from resolved repo root so a
    // `tokenomy graph serve --path` from a subdirectory still picks
    // up project-root `.tokenomy.json` overrides (e.g.
    // `graph.rebuild_worker.enabled=false`, `graph.location: "home"`).
    let cfgPath = cwd;
    try {
      cfgPath = resolveRepoId(cwd).repoPath;
    } catch {
      // best-effort; non-repo cwd loads from cwd directly.
    }
    registerRepo(cwd, loadConfig(cfgPath));
  } catch {
    // best-effort; the legacy read-driven rebuild path keeps things
    // working when the worker can't start.
  }

  await new Promise<void>((resolve) => {
    transport.onclose = () => {
      stopAllWorkers();
      resolve();
    };
  });
};
