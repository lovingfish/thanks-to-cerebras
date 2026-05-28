# Key and Model Operations Runbook

## Purpose

Use this runbook for Cerebras API key rotation, proxy key rotation, model-pool
changes, and model availability incidents.

## Cerebras API key rotation

1. Log in to the admin UI.
2. Add the new Cerebras API key through `/api/keys`.
3. Test the new key with `/api/keys/{id}/test`.
4. Delete the old key only after successful traffic through the new key.
5. Confirm `/api/stats` and `/api/metrics` show expected activity.

Never export plaintext keys. Export endpoints intentionally return `403`.

## Proxy key rotation

1. Create a new proxy key through `/api/proxy-keys`.
2. Copy the plaintext key immediately; it is shown only once.
3. Update clients to use `Authorization: Bearer <proxy-key>`.
4. Confirm requests succeed.
5. Delete the old proxy key.

## Model pool updates

1. Inspect the catalog with `/api/models/catalog`.
2. Update the active pool with `PUT /api/models`.
3. Test individual models with `/api/models/{name}/test`.
4. Watch `upstream_responses_total.404_model_not_found` and
   `proxy_requests_total.no_model`.

## Model-not-found auto-removal

When Cerebras returns a bounded `model_not_found` response, the proxy removes
that model from the active pool and retries with the next model. If all
configured models are removed or unavailable, proxy requests return a model
availability error.

## Pre-existing duplicate API key cleanup

Deployments that pre-date the value-digest index (issue #139) may contain
duplicate Cerebras API key records — two or more KV entries with different ids
but the same plaintext value. On bootstrap, `kvBackfillApiKeyValueIndex` detects
these and emits a structured warning per duplicate:

```
level: warn
event: api_key_value_index_pre_existing_duplicate
keptId: <canonical id protected by the index>
duplicateId: <unprotected legacy duplicate>
```

### Cleanup procedure

1. Delete the `duplicateId` shown in the warning log.
2. Repeat for each `api_key_value_index_pre_existing_duplicate` warning.
3. Confirm no duplicate warnings appear on the next bootstrap / deploy.
4. If both records must be removed, delete all `duplicateId`s first, then
   `keptId`.

### Why order matters

`keptId` is the canonical record — the value-digest index points at it. If you
delete `keptId` first:

- `kvDeleteKey` removes the index entry (it only deletes the index when it
  points at the id being deleted).
- The `duplicateId` record still exists in KV but now has no index protection.
- Until the next `kvBackfillApiKeyValueIndex` run (next bootstrap), a same-value
  `kvAddKey` request can succeed and create yet another duplicate.

This is an accepted migration-period window (issue #146, direction B). The fix
is operational: always delete the unprotected duplicate first.

### Do not export plaintext keys

Use only the `keptId` / `duplicateId` from the log for cleanup. The admin API
intentionally returns `403` on plaintext export endpoints.

## Recovery

- If a key is marked `invalid`, add a replacement key and delete the invalid
  one.
- If all keys are cooling down, wait for `Retry-After` or add a healthy key.
- If the model pool becomes empty, set a known-good model list with
  `PUT /api/models`.
- If catalog refresh fails but stale data exists, the admin API returns
  `stale: true`; refresh again after upstream recovers.
