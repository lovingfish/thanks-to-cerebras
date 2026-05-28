import { assertEquals } from "@std/assert";
import { AppState, state } from "../state.ts";
import { kvAddKey, kvGetApiKeyById, kvUpdateKey } from "../kv/api-keys.ts";
import { kvMigrateApiKeysToEncrypted } from "../kv/api-keys-migrate.ts";
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

Deno.test("kvMigrateApiKeysToEncrypted: preserves dirty cached stats while merging migrated keys", async () => {
  const kv = await setupKv();
  const addResult = await kvAddKey("sk-dirty-cache-migration-test");
  const dirtyId = addResult.id!;
  await kvGetApiKeyById(dirtyId);
  const dirtyKey = state.cachedKeysById.get(dirtyId);
  if (!dirtyKey) throw new Error("Expected API key to be cached");
  dirtyKey.useCount = 7;
  dirtyKey.lastUsed = 1_234;
  state.dirtyKeyIds.add(dirtyId);

  const legacyId = "legacy-migration-key";
  await kv.set([...API_KEY_PREFIX, legacyId], {
    id: legacyId,
    key: "sk-legacy-migration-test",
    useCount: 0,
    status: "active",
    createdAt: 1,
  });

  try {
    const migrated = await kvMigrateApiKeysToEncrypted();
    assertEquals(migrated, 1);

    const cached = state.cachedKeysById.get(dirtyId);
    if (!cached) throw new Error("Expected dirty API key to remain cached");
    assertEquals(cached.useCount, 7);
    assertEquals(cached.lastUsed, 1_234);
    assertEquals(state.dirtyKeyIds.has(dirtyId), true);

    const migratedEntry = await kv.get([...API_KEY_PREFIX, legacyId]);
    assertEquals((migratedEntry.value as { key?: string }).key, undefined);
    assertEquals(
      typeof (migratedEntry.value as { encryptedKey?: string }).encryptedKey,
      "string",
    );
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("markKeyInvalid: retries atomic conflicts until invalid status is persisted", async () => {
  const kv = await setupKv();
  const addResult = await kvAddKey("sk-invalid-retry-test");
  const id = addResult.id!;
  await kvGetApiKeyById(id);

  const originalAtomic = kv.atomic.bind(kv);
  let commitCount = 0;
  kv.atomic = () => {
    const op = originalAtomic();
    const originalCommit = op.commit.bind(op);
    op.commit = () => {
      commitCount++;
      if (commitCount <= 2) {
        return Promise.resolve(
          { ok: false } as unknown as Deno.KvCommitResult,
        );
      }
      return originalCommit();
    };
    return op;
  };

  try {
    await markKeyInvalid(id);
    assertEquals(commitCount, 3);
    assertEquals(state.dirtyKeyIds.has(id), false);
    assertEquals(state.cachedKeysById.get(id)?.status, "invalid");
    const entry = await kv.get([...API_KEY_PREFIX, id]);
    const persisted = entry.value as { status: string };
    assertEquals(persisted.status, "invalid");
  } finally {
    kv.atomic = originalAtomic;
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("markKeyInvalid: dirtyKeyIds retained after retry exhaustion", async () => {
  const kv = await setupKv();
  const addResult = await kvAddKey("sk-dirty-fail-test");
  const id = addResult.id!;
  await kvGetApiKeyById(id);
  state.dirtyKeyIds.add(id);

  const originalAtomic = kv.atomic.bind(kv);
  let commitCount = 0;
  kv.atomic = () => {
    const op = originalAtomic();
    op.commit = () => {
      commitCount++;
      if (commitCount < 10) {
        return Promise.resolve(
          { ok: false } as unknown as Deno.KvCommitResult,
        );
      }
      throw new Error("forced atomic failure after retry exhaustion");
    };
    return op;
  };

  try {
    await markKeyInvalid(id);
    assertEquals(commitCount, 10);
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
