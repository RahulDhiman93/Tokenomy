import { test } from "node:test";
import assert from "node:assert/strict";
import { redactPreRule } from "../../src/rules/redact-pre.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { Config } from "../../src/core/types.js";

const enabled = (): Config => ({
  ...DEFAULT_CONFIG,
  redact: { ...DEFAULT_CONFIG.redact, enabled: true, pre_tool_use: true },
});

const AWS = "AKIA" + "IOSFODNN7" + "EXAMPLE";
const JWT = "eyJabc123456789." + "abc123def456ghi789." + "xyz987wvu654tsr321";

test("redact-pre: disabled when pre_tool_use=false (default)", () => {
  const r = redactPreRule("Bash", { command: `curl -H "Authorization: Bearer ${JWT}"` }, DEFAULT_CONFIG);
  assert.equal(r.kind, "passthrough");
});

test("redact-pre: Bash header/url secrets are redacted + warned", () => {
  const r = redactPreRule(
    "Bash",
    { command: `curl -H "Authorization: Bearer ${JWT}" https://example.com` },
    enabled(),
  );
  assert.equal(r.kind, "redacted");
  const cmd = (r.updatedInput as { command: string }).command;
  assert.ok(!cmd.includes(JWT), "JWT should be removed");
  assert.ok(cmd.includes("[tokenomy: redacted"));
  assert.ok(r.additionalContext?.includes("redact-pre"));
});

test("redact-pre: Bash bare-arg secret → warn only, command not rewritten", () => {
  const cmd = `./deploy ${AWS}`;
  const r = redactPreRule("Bash", { command: cmd }, enabled());
  assert.equal(r.kind, "warned");
  assert.equal(r.updatedInput, undefined);
  assert.ok(r.additionalContext?.includes("Passthrough"));
});

test("redact-pre: Write content with AWS key is redacted inline", () => {
  const r = redactPreRule(
    "Write",
    { file_path: "/tmp/x.env", content: `AWS_KEY=${AWS}\n` },
    enabled(),
  );
  assert.equal(r.kind, "redacted");
  const content = (r.updatedInput as { content: string }).content;
  assert.ok(!content.includes(AWS));
  assert.ok(content.includes("[tokenomy: redacted aws-access-key]"));
});

test("redact-pre: Edit new_string with JWT is redacted inline", () => {
  const r = redactPreRule(
    "Edit",
    { file_path: "/tmp/x", old_string: "foo", new_string: `token = "${JWT}"` },
    enabled(),
  );
  assert.equal(r.kind, "redacted");
  const ns = (r.updatedInput as { new_string: string }).new_string;
  assert.ok(!ns.includes(JWT));
});

test("redact-pre: clean Bash command passes through", () => {
  const r = redactPreRule("Bash", { command: "ls -la /tmp" }, enabled());
  assert.equal(r.kind, "passthrough");
});

test("redact-pre: non-string command → passthrough", () => {
  const r = redactPreRule("Bash", { command: 123 }, enabled());
  assert.equal(r.kind, "passthrough");
});

test("redact-pre: counts preserved in result", () => {
  const r = redactPreRule(
    "Write",
    { file_path: "/tmp/x", content: `k1=${AWS}\nk2=${AWS}` },
    enabled(),
  );
  assert.equal(r.kind, "redacted");
  assert.equal(r.total, 2);
  assert.equal(r.counts?.["aws-access-key"], 2);
});

test("redact-pre: header + bare-arg in same command → redact header + warn bare", () => {
  const r = redactPreRule(
    "Bash",
    {
      command: `curl -H "Authorization: Bearer ${JWT}" https://example.com -d "${AWS}"`,
    },
    enabled(),
  );
  assert.equal(r.kind, "redacted");
  const cmd = (r.updatedInput as { command: string }).command;
  assert.ok(!cmd.includes(JWT), "header JWT removed");
  // bare AWS stays in the command but total counts both.
  assert.ok(r.total && r.total >= 2);
  assert.ok(r.additionalContext?.includes("bare-arg"));
});

test("redact-pre: multi-line header (line-continuation) is redacted", () => {
  const cmd = `curl -H "Authorization: Bearer ${JWT}" \\\n  https://example.com`;
  const r = redactPreRule("Bash", { command: cmd }, enabled());
  assert.equal(r.kind, "redacted");
  const rewritten = (r.updatedInput as { command: string }).command;
  assert.ok(!rewritten.includes(JWT));
});

test("redact-pre: --header long-form matches too", () => {
  const cmd = `curl --header "Authorization: Bearer ${JWT}"`;
  const r = redactPreRule("Bash", { command: cmd }, enabled());
  assert.equal(r.kind, "redacted");
});

test("redact-pre: unsupported tool → passthrough", () => {
  const r = redactPreRule("Read", { file_path: "/tmp/x" }, enabled());
  assert.equal(r.kind, "passthrough");
});
