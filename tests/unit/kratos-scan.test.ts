import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKratosScan, formatKratosScan } from "../../src/kratos/scan.js";

const withTmpHome = <T>(fn: (home: string) => T): T => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-kratos-scan-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return fn(home);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
};

test("kratos-scan: empty home → 0 servers, 0 hooks, no findings", () => {
  withTmpHome((home) => {
    const r = runKratosScan(join(home, ".tokenomy", "savings.jsonl"));
    assert.equal(r.schema_version, 1);
    assert.equal(r.findings.length, 0);
    assert.equal(r.mcp_servers.length, 0);
    assert.equal(r.hooks.length, 0);
    assert.equal(r.worst, "info");
  });
});

test("kratos-scan: claude.json with two MCP servers → exfil-pair finding", () => {
  withTmpHome((home) => {
    const claudeJson = join(home, ".claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          slack: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"] },
          atlassian: { command: "npx", args: ["-y", "@modelcontextprotocol/server-atlassian"] },
        },
      }),
    );
    const r = runKratosScan(join(home, ".tokenomy", "savings.jsonl"));
    assert.equal(r.mcp_servers.length, 2);
    assert.ok(
      r.findings.some((f) => f.category === "mcp-exfil-pair"),
      "expected an exfil-pair finding for slack ↔ atlassian",
    );
  });
});

test("kratos-scan: cursor mcp.json with HTTP URL → mcp-untrusted-server", () => {
  withTmpHome((home) => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: { url: "https://mcp.example.com/sse" },
        },
      }),
    );
    const r = runKratosScan(join(home, ".tokenomy", "savings.jsonl"));
    assert.ok(
      r.findings.some(
        (f) => f.category === "mcp-untrusted-server" && /Remote MCP server/.test(f.title),
      ),
    );
    assert.equal(r.mcp_servers[0]?.url, "https://mcp.example.com/sse");
    assert.equal(r.mcp_servers[0]?.agent, "cursor");
  });
});

test("kratos-scan: codex config.toml is parsed (TOML, not JSON)", () => {
  withTmpHome((home) => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        "model = \"gpt-5\"",
        "",
        "[mcp_servers.tokenomy-graph]",
        "command = \"tokenomy\"",
        "args = [\"graph\", \"serve\"]",
        "",
        "[mcp_servers.\"slack-bot\"]",
        "command = \"npx\"",
        "args = [\"-y\", \"@modelcontextprotocol/server-slack\"]",
        "",
        "[some.other.section]",
        "key = \"value\"",
        "",
      ].join("\n"),
    );
    const r = runKratosScan(join(home, ".tokenomy", "savings.jsonl"));
    const codexServers = r.mcp_servers.filter((s) => s.agent === "codex");
    assert.equal(codexServers.length, 2, JSON.stringify(codexServers));
    const names = codexServers.map((s) => s.name).sort();
    assert.deepEqual(names, ["slack-bot", "tokenomy-graph"]);
    const slack = codexServers.find((s) => s.name === "slack-bot")!;
    assert.equal(slack.command, "npx");
    assert.deepEqual(slack.args, ["-y", "@modelcontextprotocol/server-slack"]);
  });
});

test("kratos-scan: claude settings.json with overbroad PreToolUse → hook-overbroad", () => {
  withTmpHome((home) => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [{ command: "/usr/local/bin/some-other-tool" }],
            },
          ],
        },
      }),
    );
    const r = runKratosScan(join(home, ".tokenomy", "savings.jsonl"));
    assert.equal(r.hooks.length, 1);
    assert.ok(
      r.findings.some((f) => f.category === "hook-overbroad"),
      "expected hook-overbroad finding",
    );
    assert.ok(
      r.findings.some((f) => f.category === "config-drift"),
      "expected config-drift finding for foreign command",
    );
  });
});

test("kratos-scan: tokenomy-graph entry on cursor → not flagged as untrusted", () => {
  withTmpHome((home) => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "tokenomy-graph": { command: "tokenomy", args: ["graph", "serve"] },
        },
      }),
    );
    const r = runKratosScan(join(home, ".tokenomy", "savings.jsonl"));
    assert.equal(r.mcp_servers.length, 1);
    assert.equal(r.mcp_servers[0]?.readSource, true);
    assert.equal(r.mcp_servers[0]?.writeSink, false);
    // No untrusted-server / exfil-pair findings on the local read-only graph.
    assert.equal(r.findings.length, 0);
  });
});

test("kratos-scan: transcript-leak scan flags credential pasted into savings.jsonl", () => {
  withTmpHome((home) => {
    mkdirSync(join(home, ".tokenomy"), { recursive: true });
    const log = join(home, ".tokenomy", "savings.jsonl");
    // Build the AKIA literal at runtime so this test file's source doesn't
    // trip Tokenomy's own redact-pre rule when written.
    const akia = ["AK", "IA", "I", "OSFODNN7EXAMPLE"].join("");
    writeFileSync(
      log,
      JSON.stringify({
        ts: "2026-04-26T00:00:00Z",
        tool: "Bash",
        bytes_in: 100,
        bytes_out: 50,
        tokens_saved_est: 25,
        reason: "test",
        echo: `something ${akia} leaked`,
      }) + "\n",
    );
    const r = runKratosScan(log);
    assert.ok(
      r.findings.some((f) => f.category === "transcript-leak" && f.severity === "critical"),
    );
  });
});

test("kratos-scan: formatKratosScan produces a non-empty summary string", () => {
  withTmpHome((home) => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { remote: { url: "https://mcp.example.com/sse" } },
      }),
    );
    const r = runKratosScan(join(home, ".tokenomy", "savings.jsonl"));
    const text = formatKratosScan(r);
    assert.match(text, /Kratos scan/);
    assert.match(text, /servers=1/);
    assert.match(text, /Remote MCP server/);
  });
});

test("kratos-scan: codex hooks.json surfaces hook findings", () => {
  withTmpHome((home) => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "/usr/local/bin/some-foreign-hook" }],
            },
          ],
        },
      }),
    );
    const r = runKratosScan(join(home, ".tokenomy", "savings.jsonl"));
    assert.equal(r.hooks.length, 1);
    assert.equal(r.hooks[0]?.agent, "codex");
    // UserPromptSubmit isn't PreToolUse/PostToolUse, so hook-overbroad doesn't
    // fire — but config-drift should, since the command isn't a Tokenomy binary.
    assert.ok(
      r.findings.some((f) => f.category === "config-drift"),
      `expected config-drift for foreign codex hook: ${JSON.stringify(r.findings)}`,
    );
  });
});

test("kratos-scan: localhost-spoof hostnames don't slip past mcp-untrusted-server", () => {
  withTmpHome((home) => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          // Substring "localhost" appears in the hostname, but the host is remote.
          spoofedHost: { url: "https://localhost.attacker.com/sse" },
          // Substring "127.0.0.1" appears in the query string, but the host is remote.
          spoofedQuery: { url: "https://evil.example.com/?next=127.0.0.1" },
        },
      }),
    );
    const r = runKratosScan(join(home, ".tokenomy", "savings.jsonl"));
    const remoteFindings = r.findings.filter(
      (f) => f.category === "mcp-untrusted-server" && /Remote MCP server/.test(f.title),
    );
    // Both URLs should be flagged — the parsed hostname is the only thing that
    // matters, query strings and crafted subdomains don't get a free pass.
    assert.equal(remoteFindings.length, 2, JSON.stringify(remoteFindings));
  });
});

test("kratos-scan: real localhost / 127.0.0.1 / private-network URLs are exempted", () => {
  withTmpHome((home) => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { url: "http://localhost:9000/sse" },
          loopback: { url: "http://127.0.0.1:8080/sse" },
          rfc1918: { url: "http://10.0.0.5:7000/sse" },
        },
      }),
    );
    const r = runKratosScan(join(home, ".tokenomy", "savings.jsonl"));
    const remoteFindings = r.findings.filter(
      (f) => f.category === "mcp-untrusted-server" && /Remote MCP server/.test(f.title),
    );
    assert.equal(remoteFindings.length, 0, JSON.stringify(remoteFindings));
  });
});

test("kratos-scan: counts shape includes all severity buckets", () => {
  withTmpHome(() => {
    const r = runKratosScan("/no/such/log.jsonl");
    assert.deepEqual(Object.keys(r.counts).sort(), ["critical", "high", "info", "medium"]);
    assert.equal(r.counts.critical, 0);
    assert.equal(r.counts.high, 0);
    assert.equal(r.counts.medium, 0);
    assert.equal(r.counts.info, 0);
  });
});
