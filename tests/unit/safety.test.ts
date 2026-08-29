import { describe, expect, it } from "vitest";
import type { QAgentConfig } from "#contracts";
import { SafetyPolicyError, validateTargetSafety } from "#core";

describe("target safety policy", () => {
  it("denies active capabilities against production", () => {
    const config = baseConfig({
      target: { environment: "production", url: "https://example.com", allowed_hosts: ["example.com"] },
      safety: { destructive: true, active_security_scan: true, load_test: true, max_concurrency: 3, allow_source_commands: false }
    });

    expect(() => validateTargetSafety({ config })).toThrow(SafetyPolicyError);
  });

  it("denies unsupported URL schemes", () => {
    const config = baseConfig({
      target: { environment: "development", url: "file:///etc/passwd", allowed_hosts: [] }
    });

    expect(() => validateTargetSafety({ config })).toThrow(/scheme must be http or https/);
  });

  it("denies target URLs with embedded credentials", () => {
    const config = baseConfig({
      target: { environment: "development", url: "https://user:pass@example.com", allowed_hosts: ["example.com"] }
    });

    expect(() => validateTargetSafety({ config })).toThrow(/must not contain username or password/);
  });

  it("denies plain HTTP and private hosts for production targets", () => {
    const config = baseConfig({
      target: { environment: "production", url: "http://127.0.0.1", allowed_hosts: ["127.0.0.1"] }
    });

    expect(() => validateTargetSafety({ config })).toThrow(/production target URL must use https/);
    expect(() => validateTargetSafety({ config })).toThrow(/must not be local, reserved, or private/);
  });

  it("allows localhost only outside production", () => {
    const config = baseConfig({
      target: { environment: "local", url: "http://127.0.0.1:3000", allowed_hosts: ["127.0.0.1"] }
    });

    expect(() => validateTargetSafety({ config })).not.toThrow();
  });

  it("denies hosts outside allowed_hosts", () => {
    const config = baseConfig({
      target: { environment: "staging", url: "https://evil.example", allowed_hosts: ["staging.example.com"] }
    });

    expect(() => validateTargetSafety({ config })).toThrow(/outside allowed_hosts/);
  });

  it("normalizes allowed hosts but rejects URL-like allowlist entries", () => {
    const config = baseConfig({
      target: { environment: "staging", url: "https://example.com", allowed_hosts: ["Example.COM."] }
    });
    const unsafe = baseConfig({
      target: { environment: "staging", url: "https://example.com", allowed_hosts: ["https://example.com"] }
    });

    expect(() => validateTargetSafety({ config })).not.toThrow();
    expect(() => validateTargetSafety({ config: unsafe })).toThrow(/bare hostname or IP literal/);
  });
});

function baseConfig(overrides: Partial<QAgentConfig> = {}): QAgentConfig {
  return {
    project: { name: "test" },
    target: { environment: "staging", url: "https://staging.example.com", allowed_hosts: ["staging.example.com"] },
    safety: { destructive: false, active_security_scan: false, load_test: false, max_concurrency: 3, allow_source_commands: false },
    auth: { profiles: {} },
    api: { assertions: [], authorization: [] },
    discovery: { max_pages: 100, max_depth: 2, same_origin_only: true, exclude: [] },
    tests: { layers: ["browser", "api", "authorization"], retries: 0 },
    permissions: {},
    report: { formats: ["html", "json", "junit"], evidence_on: "failure", redact_headers: ["authorization", "cookie", "set-cookie"] },
    ...overrides
  };
}
