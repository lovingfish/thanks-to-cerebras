import { EXTERNAL_MODEL_ID } from "../constants.ts";
import { jsonError, jsonResponse } from "../http.ts";
import { isProxyAuthorized, recordProxyKeyUsage } from "../auth.ts";
import { forwardChatCompletion } from "../services/proxy.ts";
import { metrics } from "../metrics.ts";
import type { Router } from "../router.ts";

function handleModelsEndpoint(): Response {
  const now = Math.floor(Date.now() / 1000);
  return jsonResponse({
    object: "list",
    data: [
      {
        id: EXTERNAL_MODEL_ID,
        object: "model",
        created: now,
        owned_by: "cerebras",
      },
    ],
  });
}

async function handleProxyEndpoint(req: Request): Promise<Response> {
  const authResult = await isProxyAuthorized(req);
  if (!authResult.authorized) {
    metrics.inc("proxy_requests_total", "unauthorized");
    return jsonError("Unauthorized", 401);
  }

  if (authResult.keyId) {
    recordProxyKeyUsage(authResult.keyId);
  }

  let requestBody: unknown;
  try {
    requestBody = await req.json();
  } catch {
    metrics.inc("proxy_requests_total", "bad_request");
    return jsonError("代理请求处理失败", 500);
  }

  if (
    !requestBody ||
    typeof requestBody !== "object" ||
    !Array.isArray((requestBody as Record<string, unknown>).messages) ||
    (requestBody as Record<string, unknown[]>).messages.length === 0
  ) {
    metrics.inc("proxy_requests_total", "bad_request");
    return jsonError("请求体必须包含非空的 messages 数组", 400);
  }

  const result = await forwardChatCompletion(
    requestBody as Record<string, unknown>,
  );

  if (result.kind === "error") {
    return jsonError(
      result.message,
      result.status,
      result.retryAfterSec
        ? { "Retry-After": String(result.retryAfterSec) }
        : undefined,
    );
  }

  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

export function register(router: Router): void {
  router
    .get("/v1/models", handleModelsEndpoint)
    .post("/v1/chat/completions", handleProxyEndpoint);
}
