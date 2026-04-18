import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_PATTERNS, redactSecrets } from "../../src/rules/redact.js";

// All test tokens are constructed at runtime from disjoint fragments so that
// a verbatim high-entropy credential pattern never appears in this source
// file. Static scanners (GitGuardian, trufflehog, etc.) otherwise flag even
// obvious test fixtures.
const frags = {
  aws: () => "AKIA" + "IOSFODNN7" + "EXAMPLE",
  gh: () => "ghp" + "_" + "a".repeat(40),
  openai: () => "sk" + "-" + "abc123_def456-ghijklmnopqrstuv",
  anthropic: () => "sk" + "-" + "ant" + "-" + "api03-ABCdef123_456-xyzuvwABCdef123_456",
  bearer: () => "abcdef0123456789abcdefXYZ",
  jwtHead: () => "eyJ" + "hbGciOiJIUzI1NiJ9",
  jwtBody: () => "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ",
  jwtSig: () => "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  pemStart: () => "-----BEGIN " + "RSA " + "PRIVATE KEY-----",
  pemEnd: () => "-----END " + "RSA " + "PRIVATE KEY-----",
};

test("redact: AWS access key", () => {
  const r = redactSecrets(`my key is ${frags.aws()} here`);
  assert.equal(r.total, 1);
  assert.match(r.redacted, /redacted aws-access-key/);
  assert.ok(!r.redacted.includes(frags.aws()));
});

test("redact: GitHub PAT", () => {
  const token = frags.gh();
  const r = redactSecrets(`Authorization: token ${token}`);
  assert.equal(r.total, 1);
  assert.ok(!r.redacted.includes(token));
});

test("redact: OpenAI key", () => {
  const r = redactSecrets(`key=${frags.openai()}`);
  assert.equal(r.counts["openai-key"], 1);
});

test("redact: Anthropic key", () => {
  const r = redactSecrets(`use ${frags.anthropic()}`);
  assert.equal(r.counts["anthropic-key"], 1);
});

test("redact: Bearer token", () => {
  const r = redactSecrets(`Authorization: Bearer ${frags.bearer()}`);
  assert.equal(r.counts["bearer-token"], 1);
});

test("redact: JWT", () => {
  const jwt = `${frags.jwtHead()}.${frags.jwtBody()}.${frags.jwtSig()}`;
  const r = redactSecrets(`token=${jwt}`);
  assert.equal(r.counts["jwt"], 1);
});

test("redact: PEM private key block", () => {
  const pem = `${frags.pemStart()}\nMIIEpAIBAAKC...\n${frags.pemEnd()}`;
  const r = redactSecrets(`prefix\n${pem}\nsuffix`);
  assert.equal(r.counts["pem-private-key"], 1);
  assert.ok(!r.redacted.includes("MIIEpAIBAAKC"));
  assert.ok(r.redacted.includes("prefix"));
  assert.ok(r.redacted.includes("suffix"));
});

test("redact: multiple patterns in same text", () => {
  const txt = `aws=${frags.aws()} gh=${frags.gh()} openai=${frags.openai()}`;
  const r = redactSecrets(txt);
  assert.equal(r.total, 3);
});

test("redact: no false positives on plain text", () => {
  const r = redactSecrets("This is a normal sentence with some.tokens and no secrets.");
  assert.equal(r.total, 0);
});

test("redact: respects disabled patterns via custom list", () => {
  const patterns = BUILTIN_PATTERNS.filter((p) => p.name !== "jwt");
  const jwt = `${frags.jwtHead()}.${frags.jwtBody()}.${frags.jwtSig()}`;
  const r = redactSecrets(jwt, patterns);
  assert.equal(r.total, 0);
});
