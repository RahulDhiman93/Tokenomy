import { TOKENOMY_VERSION } from "../core/version.js";
import { stableStringify } from "../util/json.js";
import { dispatchGraphTool } from "./handlers.js";
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
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
};
