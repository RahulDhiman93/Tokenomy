import { randomUUID } from "node:crypto";
import { TOKENOMY_VERSION } from "../core/version.js";
import { stableStringify } from "../util/json.js";
import { dispatchGraphTool } from "./handlers.js";
import { markServerModeActive, registerRepo, stopAllWorkers } from "./rebuild-worker.js";
import { loadConfig } from "../core/config.js";
import { resolveRepoId } from "../graph/repo-id.js";
import { TOOL_DEFS } from "./schemas.js";
import { acquire, configureInflight, withDeadline } from "./inflight.js";

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

  // 0.1.10+ P4: configure inflight cap from cfg. Cfg may be a
  // subdir-resolved value; the resolved value lands here once, at
  // server boot. Tests / dev users tune via `.tokenomy.json` and
  // restart the server.
  let bootCfgInflight = 8;
  let bootCfgDeadlineMs = 5_000;
  try {
    let cfgPath = cwd;
    try {
      cfgPath = resolveRepoId(cwd).repoPath;
    } catch {
      // best-effort
    }
    const bootCfg = loadConfig(cfgPath);
    if (typeof bootCfg.mcp.max_inflight === "number") {
      bootCfgInflight = bootCfg.mcp.max_inflight;
    }
    if (typeof bootCfg.mcp.tool_deadline_ms === "number") {
      bootCfgDeadlineMs = bootCfg.mcp.tool_deadline_ms;
    }
  } catch {
    // best-effort — defaults stand
  }
  configureInflight(bootCfgInflight);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // 0.1.10+ P3: top-level structured-error catch. Any throw from
    // dispatchGraphTool or its descendants is converted to a clean
    // {ok:false, code:"internal", request_id} payload. Pre-0.1.10 a
    // bare throw escaped to the SDK and killed the transport.
    const request_id = randomUUID();
    // 0.1.10+ P4: inflight cap. Overflow returns busy synchronously.
    const slot = acquire();
    if (slot === null) {
      return {
        content: [
          {
            type: "text",
            text: stableStringify({
              ok: false,
              code: "busy",
              retry_after_ms: 50,
              request_id,
            }),
          },
        ],
        isError: true,
      };
    }
    try {
      // 0.1.10+ P4: per-tool deadline. The inner dispatch isn't
      // cancellable mid-flight today (cooperative cancel requires
      // signal threading through every BFS); the deadline just
      // surfaces a structured timeout response. The inner work
      // continues to its natural completion.
      const outcome = await withDeadline(
        () => dispatchGraphTool(request.params.name, request.params.arguments ?? {}, cwd),
        bootCfgDeadlineMs,
      );
      if (outcome.kind === "timeout") {
        return {
          content: [
            {
              type: "text",
              text: stableStringify({
                ok: false,
                code: "timeout",
                elapsed_ms: outcome.elapsed_ms,
                request_id,
              }),
            },
          ],
          isError: true,
        };
      }
      const result = outcome.value;
      return {
        content: [{ type: "text", text: stableStringify(result) }],
        isError: !result.ok,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: stableStringify({
              ok: false,
              code: "internal",
              message,
              request_id,
            }),
          },
        ],
        isError: true,
      };
    } finally {
      slot.release();
    }
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
