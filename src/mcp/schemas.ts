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
  {
    name: "find_oss_alternatives",
    description:
      "Search this repo, other local branches, and package registries for existing implementations BEFORE writing new functionality from scratch. Returns repo matches plus ranked open-source alternatives. Call this whenever the user asks to build something that may already exist locally or likely has a mature library — HTTP clients, date math, validators, parsers, auth, rate limiters, deep-merge utils, retry wrappers, caches, etc. Cheap (~1-2s) and typically saves 10-50k tokens per avoided rewrite.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "What the user is trying to build, in plain English. Used for repo/branch search and package-registry search.",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Optional additional keywords to narrow the search.",
        },
        min_weekly_downloads: {
          type: "number",
          description: "Filter threshold; overrides `nudge.oss_search.min_weekly_downloads` config for this call.",
        },
        max_results: {
          type: "number",
          description: "How many ranked candidates to return. Hard max: 10. Default from `nudge.oss_search.max_results`.",
        },
        ecosystems: {
          type: "array",
          items: { type: "string", enum: ["npm", "pypi", "go", "maven"] },
          description:
            "Optional package ecosystems to search. Defaults to project inference (package.json→npm, pyproject/setup/requirements→pypi, go.mod→go, pom/build.gradle→maven) or config fallback.",
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
  },
];
