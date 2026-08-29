const DEFAULT_SECRET_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "secret"
];

const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(password|passwd|token|api[_-]?key|secret)=([^&\s]+)/gi
];

export function redactText(input: string, extraKeys: string[] = []): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, (match, key) => {
      if (typeof key === "string" && match.includes("=")) {
        return `${key}=<redacted>`;
      }
      return "<redacted>";
    });
  }

  for (const key of [...DEFAULT_SECRET_KEYS, ...extraKeys]) {
    const escaped = escapeRegExp(key);
    output = output.replace(new RegExp(`(${escaped}\\s*[:=]\\s*)([^\\s,;]+)`, "gi"), "$1<redacted>");
  }

  return output;
}

export function redactObject<T>(input: T, extraKeys: string[] = []): T {
  const secretKeys = new Set([...DEFAULT_SECRET_KEYS, ...extraKeys].map((key) => key.toLowerCase()));
  return redactUnknown(input, secretKeys, extraKeys) as T;
}

function redactUnknown(input: unknown, secretKeys: Set<string>, extraKeys: string[]): unknown {
  if (typeof input === "string") {
    return redactText(input, extraKeys);
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactUnknown(item, secretKeys, extraKeys));
  }

  if (!input || typeof input !== "object") {
    return input;
  }

  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      secretKeys.has(key.toLowerCase()) ? "<redacted>" : redactUnknown(value, secretKeys, extraKeys)
    ])
  );
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
