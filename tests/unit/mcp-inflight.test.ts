import { test } from "node:test";
import assert from "node:assert/strict";
import {
  _resetInflightForTests,
  acquire,
  configureInflight,
  inflightCount,
  inflightMax,
  withDeadline,
} from "../../src/mcp/inflight.js";

test("acquire: returns slot under cap, null at cap", () => {
  _resetInflightForTests();
  configureInflight(3);
  const a = acquire();
  const b = acquire();
  const c = acquire();
  const d = acquire();
  assert.ok(a);
  assert.ok(b);
  assert.ok(c);
  assert.equal(d, null);
  assert.equal(inflightCount(), 3);
  assert.equal(inflightMax(), 3);
  a!.release();
  assert.equal(inflightCount(), 2);
  const e = acquire();
  assert.ok(e, "free slot after release");
});

test("acquire: double-release is idempotent", () => {
  _resetInflightForTests();
  configureInflight(2);
  const a = acquire();
  assert.ok(a);
  a!.release();
  a!.release();
  assert.equal(inflightCount(), 0);
});

test("acquire: 10 parallel requests, 8 succeed, 2 get busy", () => {
  _resetInflightForTests();
  configureInflight(8);
  const slots: ReturnType<typeof acquire>[] = [];
  let busyCount = 0;
  for (let i = 0; i < 10; i++) {
    const s = acquire();
    if (s) slots.push(s);
    else busyCount++;
  }
  assert.equal(slots.length, 8);
  assert.equal(busyCount, 2);
});

test("withDeadline: returns ok within deadline", async () => {
  const out = await withDeadline(async () => 42, 100);
  assert.equal(out.kind, "ok");
  if (out.kind === "ok") assert.equal(out.value, 42);
});

test("withDeadline: returns timeout when work exceeds deadline", async () => {
  const out = await withDeadline(
    () => new Promise<number>((r) => setTimeout(() => r(1), 50)),
    10,
  );
  assert.equal(out.kind, "timeout");
  if (out.kind === "timeout") {
    assert.ok(out.elapsed_ms >= 10);
  }
});

test("configureInflight: rejects non-finite + non-positive", () => {
  _resetInflightForTests();
  configureInflight(8);
  configureInflight(NaN);
  assert.equal(inflightMax(), 8);
  configureInflight(0);
  assert.equal(inflightMax(), 8);
  configureInflight(-1);
  assert.equal(inflightMax(), 8);
  configureInflight(16);
  assert.equal(inflightMax(), 16);
});
