import { adminJsonResponse, jsonResponse } from "../http.ts";
import { kvGetConfig } from "../kv/config.ts";
import { state } from "../state.ts";
import type { Router } from "../router.ts";

type ReadinessChecks = {
  keyEncryptionSecret: boolean;
  kv: boolean;
  config: boolean;
};

function getHealthz(): Response {
  return new Response("ok", { status: 200 });
}

async function getReadinessChecks(): Promise<ReadinessChecks> {
  const checks: ReadinessChecks = {
    keyEncryptionSecret: Boolean(Deno.env.get("KEY_ENCRYPTION_SECRET")?.trim()),
    kv: Boolean(state.kv),
    config: false,
  };

  if (checks.kv) {
    try {
      await kvGetConfig();
      checks.config = true;
    } catch {
      checks.config = false;
    }
  }

  return checks;
}

function isReady(checks: ReadinessChecks): boolean {
  return Object.values(checks).every(Boolean);
}

async function getReadyz(): Promise<Response> {
  const checks = await getReadinessChecks();
  const ready = isReady(checks);
  return jsonResponse({ ready }, {
    status: ready ? 200 : 503,
    cors: "admin",
  });
}

async function getDiagnostics(): Promise<Response> {
  const checks = await getReadinessChecks();
  const ready = isReady(checks);
  return adminJsonResponse({ ready, checks });
}

export function register(router: Router): void {
  router
    .get("/healthz", getHealthz)
    .get("/readyz", getReadyz)
    .get("/api/diagnostics", getDiagnostics);
}
