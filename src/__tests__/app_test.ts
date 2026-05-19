import { assertEquals } from "@std/assert";
import { createHandler, createRouter } from "../app.ts";
import { type LogLevel, setLogSinkForTests } from "../logger.ts";

const BASE = "http://localhost";

function makeReq(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, { method, headers });
}

Deno.test("app: responses include request IDs and structured request logs", async () => {
  const logs: Array<{ level: LogLevel; line: string }> = [];
  setLogSinkForTests((level, line) => logs.push({ level, line }));
  const handler = createHandler(createRouter());

  try {
    const providedId = "req-test-123";
    const echoed = await handler(
      makeReq("GET", "/healthz", { "X-Request-Id": providedId }),
    );
    assertEquals(echoed.headers.get("x-request-id"), providedId);

    const generated = await handler(makeReq("GET", "/v1/models"));
    const generatedId = generated.headers.get("x-request-id");
    assertEquals(typeof generatedId, "string");
    assertEquals(generatedId === providedId, false);

    const records = logs.map(({ line }) => JSON.parse(line));
    const echoedLog = records.find((record) => record.requestId === providedId);
    if (!echoedLog) throw new Error("missing echoed request log");
    assertEquals(echoedLog.level, "info");
    assertEquals(echoedLog.event, "http_request");
    assertEquals(echoedLog.method, "GET");
    assertEquals(echoedLog.path, "/healthz");
    assertEquals(echoedLog.status, 200);

    const oversizedId = "r".repeat(129);
    const sanitized = await handler(
      makeReq("GET", "/healthz", { "X-Request-Id": oversizedId }),
    );
    const sanitizedId = sanitized.headers.get("x-request-id");
    assertEquals(sanitizedId === oversizedId, false);

    const generatedLog = records.find((record) =>
      record.requestId === generatedId
    );
    if (!generatedLog) throw new Error("missing generated request log");
    assertEquals(generatedLog.event, "http_request");
    assertEquals(generatedLog.path, "/v1/models");
  } finally {
    setLogSinkForTests(null);
  }
});
