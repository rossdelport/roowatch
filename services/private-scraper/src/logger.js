const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|storage.?state|token|post(s)?|content|text|payload)/i;

export function sanitiseText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_token|token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 800);
}

function redact(value, key = "", depth = 0) {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return sanitiseText(value);
  if (value instanceof Error) {
    return { name: value.name, message: sanitiseText(value.message) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, childKey, depth + 1)
      ])
    );
  }
  return value;
}

export function createLogger(output = process.stdout) {
  function write(level, event, fields = {}) {
    output.write(`${JSON.stringify({
      at: new Date().toISOString(),
      level,
      event,
      ...redact(fields)
    })}\n`);
  }

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}
