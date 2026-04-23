import { test } from "node:test";
import assert from "node:assert/strict";
import { compressDeterministic, containsNulByte } from "../../src/compress/deterministic.js";

test("compressDeterministic: trims whitespace, duplicate adjacent bullets, duplicate adjacent headers", () => {
  const input = `---
title: Keep
---

## Background
## Background

- Use the graph first.   
- Use the graph first.
- Keep the result.



Long hyphen-
broken line.
`;
  const out = compressDeterministic(input).text;
  assert.equal(out.includes("---\ntitle: Keep\n---"), true);
  assert.equal((out.match(/## Background/g) ?? []).length, 1);
  assert.equal((out.match(/Use the graph first/g) ?? []).length, 1);
  assert.equal(out.includes("\n\n\n"), false);
  assert.equal(out.includes("Long hyphenbroken line."), true);
});

test("compressDeterministic: preserves fenced and indented code byte-for-byte", () => {
  const code = "```bash\nnpm test   \nhttps://example.com/a-b\n```\n";
  const indented = "    const value = 'keep trailing spaces';   \n";
  const input = `# Rules\n${code}\n${indented}\n- repeat\n- repeat\n`;
  const out = compressDeterministic(input).text;
  assert.equal(out.includes(code), true);
  assert.equal(out.includes(indented), true);
  assert.equal((out.match(/- repeat/g) ?? []).length, 1);
});

test("containsNulByte detects binary-looking content", () => {
  assert.equal(containsNulByte(Buffer.from("abc\0def")), true);
  assert.equal(containsNulByte(Buffer.from("abcdef")), false);
});

