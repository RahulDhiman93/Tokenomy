export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean;
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const TOOL_DEFS: ToolDefinition[] = [
  {
    name: "build_or_update_graph",
    description: "Build or refresh the local Tokenomy code graph for the current repository.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean" },
        path: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_minimal_context",
    description: "Return the smallest useful neighborhood around a file or symbol.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: {
            file: { type: "string" },
            symbol: { type: "string" },
          },
          required: ["file"],
          additionalProperties: false,
        },
        depth: { type: "number", minimum: 1, maximum: 2 },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "get_impact_radius",
    description: "Return reverse dependencies and suggested tests for changed files or symbols.",
    inputSchema: {
      type: "object",
      properties: {
        changed: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              symbols: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["file"],
            additionalProperties: false,
          },
        },
        max_depth: { type: "number", minimum: 1, maximum: 3 },
      },
      required: ["changed"],
      additionalProperties: false,
    },
  },
  {
    name: "get_review_context",
    description: "Rank changed files and repo hotspots for code review.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
  },
  {
    name: "find_usages",
    description:
      "Return direct usage sites (callers, references, importers) of a file or symbol. Complements get_impact_radius (which walks reverse deps transitively).",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: {
            file: { type: "string" },
            symbol: { type: "string" },
          },
          required: ["file"],
          additionalProperties: false,
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
];
