import { assertEquals } from "@std/assert";
import { createHandler, createRouter } from "../app.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { metrics } from "../metrics.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";
import { AppState, state } from "../state.ts";
import { setLogSinkForTests } from "../logger.ts";

const BASE = "http://localhost";

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) clearInterval(state.kvFlushTimerId);
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("SETUP_TOKEN", "test-setup-token");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  await bootstrapCache();
  await resetKvRateLimitsForTests();
  await resetProxyStreamCountersForTests();
  metrics.reset();
  setLogSinkForTests(() => {});
  return kv;
}

function makeReq(path: string, headers?: HeadersInit): Request {
  return new Request(`${BASE}${path}`, { headers });
}

Deno.test("health: GET /readyz returns 200 with only ready field when healthy", async () => {
  const kv = await setupKv();
  const handler = createHandler(createRouter());

  try {
    const res = await handler(makeReq("/readyz"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ready, true);
    assertEquals(body.checks, undefined);
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("health: GET /readyz returns 503 with only ready field when KV unavailable", async () => {
  const kv = await setupKv();
  const handler = createHandler(createRouter());
  const originalKv = state.kv;
  state.kv = undefined as unknown as Deno.Kv;

  try {
    const res = await handler(makeReq("/readyz"));
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.ready, false);
    assertEquals(body.checks, undefined);
  } finally {
    state.kv = originalKv;
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("health: GET /api/diagnostics returns 401 without admin token", async () => {
  const kv = await setupKv();
  const handler = createHandler(createRouter());

  try {
    const res = await handler(makeReq("/api/diagnostics"));
    assertEquals(res.status, 401);
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("health: GET /api/diagnostics returns checks with admin token", async () => {
  const kv = await setupKv();
  const handler = createHandler(createRouter());

  try {
    const setupRes = await handler(
      new Request(`${BASE}/api/auth/setup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Setup-Token": "test-setup-token",
        },
        body: JSON.stringify({ password: "testpass" }),
      }),
    );
    assertEquals(setupRes.status, 200);
    const { token } = await setupRes.json();
    const res = await handler(makeReq("/api/diagnostics", {
      "X-Admin-Token": token,
    }));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ready, true);
    assertEquals(body.checks.keyEncryptionSecret, true);
    assertEquals(body.checks.kv, true);
    assertEquals(body.checks.config, true);
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});
