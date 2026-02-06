import { assertEquals } from "@std/assert";
import { AppState, state } from "../state.ts";
import { createHandler, createRouter } from "../app.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { loginLimiter } from "../rate-limit.ts";
import { metrics } from "../metrics.ts";
import { ADMIN_CORS_HEADERS, CORS_HEADERS } from "../constants.ts";

const BASE = "http://localhost";

type Handler = (req: Request) => Promise<Response>;

function buildHandler(): Handler {
  return createHandler(createRouter());
}

function makeReq(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const init: RequestInit = {
    method,
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.headers ?? {}),
    },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  return new Request(`${BASE}${path}`, init);
}

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
  }
  const kv = await Deno.openKv(":memory:");
  Object.assign(state, new AppState());
  state.kv = kv;
  await bootstrapCache();
  loginLimiter.reset();
  metrics.reset();
  return kv;
}

async function setupAuth(handler: Handler): Promise<string> {
  const res = await handler(
    makeReq("POST", "/api/auth/setup", { body: { password: "test1234" } }),
  );
  const { token } = await res.json();
  return token;
}

// ─── Auth Flow ───

Deno.test("integration: auth setup → login → logout", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const status1 = await (await handler(
    makeReq("GET", "/api/auth/status"),
  )).json();
  assertEquals(status1.hasPassword, false);
  assertEquals(status1.isLoggedIn, false);

  const setupRes = await handler(
    makeReq("POST", "/api/auth/setup", { body: { password: "test1234" } }),
  );
  assertEquals(setupRes.status, 200);
  const setupBody = await setupRes.json();
  assertEquals(setupBody.success, true);
  const token = setupBody.token;

  const status2 = await (await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": token },
    }),
  )).json();
  assertEquals(status2.isLoggedIn, true);

  const dupRes = await handler(
    makeReq("POST", "/api/auth/setup", { body: { password: "other" } }),
  );
  assertEquals(dupRes.status, 400);

  const loginRes = await handler(
    makeReq("POST", "/api/auth/login", { body: { password: "test1234" } }),
  );
  assertEquals(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assertEquals(loginBody.success, true);

  const badLogin = await handler(
    makeReq("POST", "/api/auth/login", { body: { password: "wrong" } }),
  );
  assertEquals(badLogin.status, 401);

  await handler(
    makeReq("POST", "/api/auth/logout", {
      headers: { "X-Admin-Token": token },
    }),
  );
  const status3 = await (await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": token },
    }),
  )).json();
  assertEquals(status3.isLoggedIn, false);

  kv.close();
});

// ─── Admin auth guard ───

Deno.test("integration: admin endpoints require auth", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(makeReq("GET", "/api/keys"));
  assertEquals(res.status, 401);

  kv.close();
});

// ─── API Key CRUD ───

Deno.test("integration: API key add → list → delete", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const addRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-test-abc123" },
    }),
  );
  assertEquals(addRes.status, 201);
  const addBody = await addRes.json();
  assertEquals(addBody.success, true);
  const keyId = addBody.id;

  const dupRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-test-abc123" },
    }),
  );
  assertEquals(dupRes.status, 409);

  const listRes = await handler(makeReq("GET", "/api/keys", { headers: h }));
  assertEquals(listRes.status, 200);
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 1);
  assertEquals(listBody.keys[0].id, keyId);

  const delRes = await handler(
    makeReq("DELETE", `/api/keys/${keyId}`, { headers: h }),
  );
  assertEquals(delRes.status, 200);

  const listRes2 = await handler(makeReq("GET", "/api/keys", { headers: h }));
  const listBody2 = await listRes2.json();
  assertEquals(listBody2.keys.length, 0);

  kv.close();
});

// ─── Proxy Key CRUD ───

Deno.test("integration: proxy key add → list → export → delete", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const addRes = await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: h,
      body: { name: "Test Key" },
    }),
  );
  assertEquals(addRes.status, 201);
  const addBody = await addRes.json();
  assertEquals(addBody.success, true);
  const pkId = addBody.id;
  const rawKey = addBody.key;

  const listRes = await handler(
    makeReq("GET", "/api/proxy-keys", { headers: h }),
  );
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 1);
  assertEquals(listBody.keys[0].name, "Test Key");

  const exportRes = await handler(
    makeReq("GET", `/api/proxy-keys/${pkId}/export`, { headers: h }),
  );
  const exportBody = await exportRes.json();
  assertEquals(exportBody.key, rawKey);

  const delRes = await handler(
    makeReq("DELETE", `/api/proxy-keys/${pkId}`, { headers: h }),
  );
  assertEquals(delRes.status, 200);

  const listRes2 = await handler(
    makeReq("GET", "/api/proxy-keys", { headers: h }),
  );
  const listBody2 = await listRes2.json();
  assertEquals(listBody2.keys.length, 0);

  kv.close();
});

// ─── Config ───

Deno.test("integration: config get → update", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const getRes = await handler(makeReq("GET", "/api/config", { headers: h }));
  assertEquals(getRes.status, 200);
  const getBody = await getRes.json();
  assertEquals(typeof getBody.kvFlushIntervalMs, "number");
  assertEquals(typeof getBody.totalRequests, "number");

  const updateRes = await handler(
    makeReq("PATCH", "/api/config", {
      headers: h,
      body: { kvFlushIntervalMs: 5000 },
    }),
  );
  assertEquals(updateRes.status, 200);
  const updateBody = await updateRes.json();
  assertEquals(updateBody.success, true);
  assertEquals(updateBody.kvFlushIntervalMs, 5000);

  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
    state.kvFlushTimerId = null;
  }

  kv.close();
});

// ─── Stats ───

Deno.test("integration: stats endpoint", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-stat-test" },
    }),
  );

  const statsRes = await handler(
    makeReq("GET", "/api/stats", { headers: h }),
  );
  assertEquals(statsRes.status, 200);
  const statsBody = await statsRes.json();
  assertEquals(statsBody.totalKeys, 1);
  assertEquals(statsBody.activeKeys, 1);

  kv.close();
});

// ─── Batch import ───

Deno.test("integration: batch import API keys", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const batchRes = await handler(
    makeReq("POST", "/api/keys/batch", {
      headers: h,
      body: { input: "sk-batch-1\nsk-batch-2\nsk-batch-3" },
    }),
  );
  assertEquals(batchRes.status, 200);
  const batchBody = await batchRes.json();
  assertEquals(batchBody.summary.total, 3);
  assertEquals(batchBody.summary.success, 3);
  assertEquals(batchBody.summary.failed, 0);

  const listRes = await handler(makeReq("GET", "/api/keys", { headers: h }));
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 3);

  kv.close();
});

// ─── Proxy: 401 unauthorized (proxy key required) ───

Deno.test("integration: proxy 401 when proxy key exists but token missing", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);

  await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: { "X-Admin-Token": token },
      body: { name: "gate" },
    }),
  );

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 401);

  const resInvalid = await handler(
    makeReq("POST", "/v1/chat/completions", {
      headers: { Authorization: "Bearer invalid-token" },
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(resInvalid.status, 401);

  kv.close();
});

// ─── Proxy: 400 bad request body ───

Deno.test("integration: proxy 400 when messages missing or empty", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res1 = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { not_messages: true },
    }),
  );
  assertEquals(res1.status, 400);

  const res2 = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [] },
    }),
  );
  assertEquals(res2.status, 400);

  kv.close();
});

// ─── Proxy: 500 no API keys ───

Deno.test("integration: proxy 500 when no API keys available", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "没有可用的 API 密钥");

  kv.close();
});

// ─── Proxy: 429 all keys on cooldown ───

Deno.test("integration: proxy 429 when all API keys on cooldown", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);

  const addRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-cooldown-test" },
    }),
  );
  const { id } = await addRes.json();

  state.keyCooldownUntil.set(id, Date.now() + 600_000);

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 429);

  kv.close();
});

// ─── Proxy: 503 no models in pool ───

Deno.test("integration: proxy 503 when model pool is empty", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);

  await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-model-test" },
    }),
  );

  state.cachedModelPool = [];

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error, "没有可用的模型");

  kv.close();
});

// ─── Models: GET + PUT ───

Deno.test("integration: models GET and PUT", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const getRes = await handler(makeReq("GET", "/api/models", { headers: h }));
  assertEquals(getRes.status, 200);
  const getBody = await getRes.json();
  assertEquals(Array.isArray(getBody.models), true);
  assertEquals(getBody.models.length > 0, true);

  const putRes = await handler(
    makeReq("PUT", "/api/models", {
      headers: h,
      body: { models: ["test-model-a", "test-model-b"] },
    }),
  );
  assertEquals(putRes.status, 200);
  const putBody = await putRes.json();
  assertEquals(putBody.success, true);
  assertEquals(putBody.models, ["test-model-a", "test-model-b"]);

  const getRes2 = await handler(
    makeReq("GET", "/api/models", { headers: h }),
  );
  const getBody2 = await getRes2.json();
  assertEquals(getBody2.models, ["test-model-a", "test-model-b"]);

  const badPut = await handler(
    makeReq("PUT", "/api/models", {
      headers: h,
      body: { models: [] },
    }),
  );
  assertEquals(badPut.status, 400);

  kv.close();
});

// ─── CORS: OPTIONS preflight ───

Deno.test("integration: OPTIONS returns correct CORS headers", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const proxyOpts = await handler(makeReq("OPTIONS", "/v1/chat/completions"));
  assertEquals(proxyOpts.status, 204);
  assertEquals(
    proxyOpts.headers.get("Access-Control-Allow-Origin"),
    CORS_HEADERS["Access-Control-Allow-Origin"],
  );
  assertEquals(
    proxyOpts.headers.get("Access-Control-Allow-Methods"),
    CORS_HEADERS["Access-Control-Allow-Methods"],
  );

  const adminOpts = await handler(makeReq("OPTIONS", "/api/keys"));
  assertEquals(adminOpts.status, 204);
  assertEquals(adminOpts.headers.has("Access-Control-Allow-Origin"), false);
  assertEquals(
    adminOpts.headers.get("Access-Control-Allow-Methods"),
    ADMIN_CORS_HEADERS["Access-Control-Allow-Methods"],
  );

  kv.close();
});

// ─── Healthz ───

Deno.test("integration: GET /healthz returns 200", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(makeReq("GET", "/healthz"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");

  kv.close();
});

// ─── 404 ───

Deno.test("integration: unknown path returns 404", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(makeReq("GET", "/nonexistent"));
  assertEquals(res.status, 404);

  kv.close();
});

// ─── Metrics ───

Deno.test("integration: /api/metrics returns counters (requires auth)", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);

  await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );

  const res = await handler(
    makeReq("GET", "/api/metrics", {
      headers: { "X-Admin-Token": token },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body, "object");
  assertEquals(typeof body.proxy_requests_total, "object");

  const noAuth = await handler(makeReq("GET", "/api/metrics"));
  assertEquals(noAuth.status, 401);

  kv.close();
});
