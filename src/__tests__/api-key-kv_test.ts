import { assertEquals } from "@std/assert";
import { AppState, state } from "../state.ts";
import { kvAddKey, kvUpdateKey } from "../kv/api-keys.ts";
import { kvGetApiKeyById } from "../kv/api-keys.ts";
import { markKeyInvalid } from "../api-keys.ts";
import { API_KEY_PREFIX } from "../constants.ts";
import { setLogSinkForTests } from "../logger.ts";
import { testKey } from "../services/api-keys.ts";

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) clearInterval(state.kvFlushTimerId);
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  setLogSinkForTests(() => {});
  return kv;
}

Deno.test("kvUpdateKey: retries on atomic conflict and eventually succeeds", async () => {
  const kv = await setupKv();
  const addResult = await kvAddKey("sk-retry-test-key");
  const id = addResult.id!;
  await kvGetApiKeyById(id);

  const originalAtomic = kv.atomic.bind(kv);
  let callCount = 0;
  kv.atomic = () => {
    callCount++;
    const op = originalAtomic();
    if (callCount <= 2) {
      op.commit = () => {
        return Promise.resolve(
          { ok: false } as unknown as Deno.KvCommitResult,
        );
      };
    }
    return op;
  };

  try {
    const result = await kvUpdateKey(id, { status: "inactive" });
    assertEquals(result.updated, true);
    assertEquals(state.cachedKeysById.get(id)?.status, "inactive");
  } finally {
    kv.atomic = originalAtomic;
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("kvUpdateKey: returns updated false and cleans cache when KV entry missing", async () => {
  const kv = await setupKv();
  const addResult = await kvAddKey("sk-missing-entry-test");
  const id = addResult.id!;
  await kvGetApiKeyById(id);

  state.dirtyKeyIds.add(id);
  state.keyCooldownUntil.set(id, Date.now() + 60_000);

  await kv.delete([...API_KEY_PREFIX, id]);

  try {
    const result = await kvUpdateKey(id, { status: "inactive" });
    assertEquals(result.updated, false);
    assertEquals(state.cachedKeysById.has(id), false);
    assertEquals(state.keyCooldownUntil.has(id), false);
    assertEquals(state.dirtyKeyIds.has(id), false);
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("kvUpdateKey: returns updated false when key not in memory or KV", async () => {
  const kv = await setupKv();

  try {
    const result = await kvUpdateKey("nonexistent-id", { status: "inactive" });
    assertEquals(result.updated, false);
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("markKeyInvalid: dirtyKeyIds retained on commit failure", async () => {
  const kv = await setupKv();
  const addResult = await kvAddKey("sk-dirty-fail-test");
  const id = addResult.id!;
  await kvGetApiKeyById(id);
  state.dirtyKeyIds.add(id);

  const originalAtomic = kv.atomic.bind(kv);
  kv.atomic = () => {
    const op = originalAtomic();
    op.commit = () => {
      return Promise.resolve(
        { ok: false } as unknown as Deno.KvCommitResult,
      );
    };
    return op;
  };

  try {
    await markKeyInvalid(id);
    assertEquals(state.dirtyKeyIds.has(id), true);
    assertEquals(state.cachedKeysById.get(id)?.status, "invalid");
  } finally {
    kv.atomic = originalAtomic;
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("markKeyInvalid: dirtyKeyIds deleted on commit success", async () => {
  const kv = await setupKv();
  const addResult = await kvAddKey("sk-dirty-success-test");
  const id = addResult.id!;
  await kvGetApiKeyById(id);
  state.dirtyKeyIds.add(id);

  try {
    await markKeyInvalid(id);
    assertEquals(state.dirtyKeyIds.has(id), false);
    assertEquals(state.cachedKeysById.get(id)?.status, "invalid");
    const entry = await kv.get([...API_KEY_PREFIX, id]);
    const persisted = entry.value as { status: string };
    assertEquals(persisted.status, "invalid");
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("testKey: returns error when key concurrently deleted (kvUpdateKey returns updated false)", async () => {
  const kv = await setupKv();
  const addResult = await kvAddKey("sk-concurrent-delete-test");
  const id = addResult.id!;
  await kvGetApiKeyById(id);
  state.cachedModelPool = ["test-model"];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("{}", { status: 200 }));

  await kv.delete([...API_KEY_PREFIX, id]);

  try {
    const result = await testKey(id);
    assertEquals(result.success, false);
    assertEquals(result.status, "invalid");
    assertEquals(result.error, "密钥不存在");
  } finally {
    globalThis.fetch = originalFetch;
    setLogSinkForTests(null);
    kv.close();
  }
});
