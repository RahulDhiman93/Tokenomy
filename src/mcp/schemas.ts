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

// 0.1.3+: every tool gets an optional `path` arg so callers can route a
// query at a specific repo. Without this, every call uses the MCP server's
// startup cwd — wrong when the agent works across multiple repos in one
// session. Applied via post-process below so individual tool schemas
// stay clean.
const PATH_PROP: JsonSchema = {
  type: "string",
  description:
    "Repository path to scope this query. Defaults to the MCP server's startup cwd. Pass an absolute path (e.g. \"$PWD\") when working across multiple repos in one session so Tokenomy resolves the correct per-repo graph + Raven store.",
};

const RAW_TOOL_DEFS: ToolDefinition[] = [
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
  {
    name: "create_handoff_packet",
    description: "Create a Tokenomy Raven handoff packet for Claude Code review, handoff, or PR readiness.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        target_agent: { type: "string", enum: ["claude-code", "codex", "human"] },
        intent: { type: "string", enum: ["review", "handoff", "pr-check", "second-opinion"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_handoff_packet",
    description: "Read the latest or named Tokenomy Raven handoff packet.",
    inputSchema: {
      type: "object",
      properties: { packet_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "record_agent_review",
    description: "Persist review findings for the current Raven packet. Refuses stale packet HEADs.",
    inputSchema: {
      type: "object",
      properties: {
        packet_id: { type: "string" },
        agent: { type: "string", enum: ["claude-code", "codex", "human"] },
        verdict: { type: "string", enum: ["pass", "needs-work", "risky", "blocked"] },
        findings: { type: "array", items: { type: "object", additionalProperties: true } },
        questions: { type: "array", items: { type: "string" } },
        suggested_tests: { type: "array", items: { type: "string" } },
      },
      required: ["agent", "verdict"],
      additionalProperties: false,
    },
  },
  {
    name: "list_agent_reviews",
    description: "List Raven reviews for the latest or named packet.",
    inputSchema: {
      type: "object",
      properties: { packet_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "compare_agent_reviews",
    description: "Deterministically compare Raven reviews for the latest or named packet.",
    inputSchema: {
      type: "object",
      properties: { packet_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_pr_readiness",
    description: "Return Raven PR readiness from packet freshness, reviews, graph state, and disagreements.",
    inputSchema: {
      type: "object",
      properties: { packet_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "record_decision",
    description: "Persist a human or agent Raven decision for a fresh packet.",
    inputSchema: {
      type: "object",
      properties: {
        packet_id: { type: "string" },
        decision: { type: "string", enum: ["merge", "fix-first", "investigate", "defer", "abandon"] },
        rationale: { type: "string" },
        decided_by: { type: "string", enum: ["human", "claude-code", "codex"] },
        review_ids: { type: "array", items: { type: "string" } },
      },
      required: ["decision", "rationale", "decided_by"],
      additionalProperties: false,
    },
  },
];

// Post-process: inject `path` into every tool's properties. Skip
// `build_or_update_graph` because it already declares it. Idempotent; if a
// future tool adds `path` directly, this leaves the existing entry alone.
export const TOOL_DEFS: ToolDefinition[] = RAW_TOOL_DEFS.map((tool) => {
  if (!tool.inputSchema.properties) return tool;
  if (tool.inputSchema.properties["path"]) return tool;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        path: PATH_PROP,
      },
    },
  };
});
