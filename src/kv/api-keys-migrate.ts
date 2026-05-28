import type { ApiKey } from "../types.ts";
import { API_KEY_PREFIX } from "../constants.ts";
import { encryptApiKey } from "../secrets.ts";
import { state } from "../state.ts";
import { kvMergeAllApiKeysIntoCache } from "./api-keys.ts";

type LegacyApiKey = Omit<ApiKey, "encryptedKey"> & { key: string };

export async function kvMigrateApiKeysToEncrypted(): Promise<number> {
  let migrated = 0;
  const iter = state.kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    const value = entry.value as Partial<LegacyApiKey> & Partial<ApiKey>;
    if (typeof value.encryptedKey === "string") continue;
    if (typeof value.key !== "string") {
      throw new Error("API key 迁移失败：旧记录缺少明文 key");
    }

    const encryptedKey = await encryptApiKey(value.key);
    const migratedValue = {
      id: value.id,
      useCount: value.useCount,
      lastUsed: value.lastUsed,
      status: value.status,
      createdAt: value.createdAt,
      encryptedKey,
    };
    if (
      typeof migratedValue.id !== "string" ||
      typeof migratedValue.useCount !== "number" ||
      typeof migratedValue.status !== "string" ||
      typeof migratedValue.createdAt !== "number"
    ) {
      throw new Error("API key 迁移失败：旧记录结构不完整");
    }
    const result = await state.kv.atomic()
      .check(entry)
      .set(entry.key, migratedValue)
      .commit();
    if (!result.ok) throw new Error("API key 迁移失败：KV 写入冲突");
    state.cachedKeysById.delete(migratedValue.id);
    migrated++;
  }
  if (migrated > 0) {
    await kvMergeAllApiKeysIntoCache();
  }
  return migrated;
}
