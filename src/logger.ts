export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

export type LogSink = (level: LogLevel, line: string) => void;

function defaultSink(level: LogLevel, line: string): void {
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

let sink: LogSink = defaultSink;

function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }
  return { errorMessage: String(error) };
}

function writeLog(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
  error?: unknown,
): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
    ...(error === undefined ? {} : serializeError(error)),
  };
  const line = JSON.stringify(record);
  sink(level, line);
}

export const logger = {
  info(event: string, fields?: LogFields): void {
    writeLog("info", event, fields);
  },
  warn(event: string, fields?: LogFields, error?: unknown): void {
    writeLog("warn", event, fields, error);
  },
  error(event: string, fields?: LogFields, error?: unknown): void {
    writeLog("error", event, fields, error);
  },
};

export function setLogSinkForTests(nextSink: LogSink | null): void {
  sink = nextSink ?? defaultSink;
}
