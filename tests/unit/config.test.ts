import { describe, expect, it } from "vitest";
import { ConfigValidationError, createConfigFromOverrides, parseQAgentConfig, resolveAuthProfile } from "#config";

describe("QAgent config", () => {
  it("loads a valid minimal config with safe defaults", () => {
    const config = parseQAgentConfig(`
project:
  name: lms
target:
  environment: staging
  url: https://staging.example.com
`);

    expect(config.project.name).toBe("lms");
    expect(config.target.allowed_hosts).toEqual(["staging.example.com"]);
    expect(config.safety.destructive).toBe(false);
    expect(config.discovery.max_depth).toBe(2);
    expect(config.performance.engine).toBe("browser-timing");
    expect(config.performance.thresholds.maxLoadEventMs).toBe(5000);
    expect(config.security.engine).toBe("passive-http");
    expect(config.load.engine).toBe("http-smoke");
    expect(config.load.thresholds.maxErrorRate).toBe(0);
    expect(config.tests.layers).toEqual(["browser", "api", "authorization"]);
  });

  it("rejects unknown critical fields", () => {
    expect(() =>
      parseQAgentConfig(`
project:
  name: lms
target:
  environment: staging
unsafe_magic: true
`)
    ).toThrow(ConfigValidationError);
  });

  it("creates a cloud config from a URL override", () => {
    const config = createConfigFromOverrides({
      cwd: process.cwd(),
      urlOverride: "http://localhost:3000"
    });

    expect(config.target.environment).toBe("local");
    expect(config.target.allowed_hosts).toEqual(["localhost"]);
  });

  it("parses and resolves S3 auth profiles from environment variables", () => {
    const config = parseQAgentConfig(`
project:
  name: lms
target:
  environment: local
  url: http://127.0.0.1:3000
auth:
  profiles:
    admin:
      loginUrl: /login
      credentials:
        username: \${ADMIN_EMAIL}
        password: \${ADMIN_PASSWORD}
      selectors:
        username: '[name="email"]'
        password: '[name="password"]'
        submit: 'button[type="submit"]'
      success:
        urlContains: /dashboard
`);

    const profile = resolveAuthProfile(config, "admin", {
      ADMIN_EMAIL: "admin@test.local",
      ADMIN_PASSWORD: "Password123!"
    });

    expect(profile.loginUrl).toBe("/login");
    expect(profile.credentials.username).toBe("admin@test.local");
    expect(profile.credentials.password).toBe("Password123!");
  });

  it("fails safely when auth credential environment variables are missing", () => {
    const config = parseQAgentConfig(`
project:
  name: lms
target:
  environment: local
auth:
  profiles:
    admin:
      loginUrl: /login
      credentials:
        username: \${ADMIN_EMAIL}
        password: \${ADMIN_PASSWORD}
      selectors:
        username: '[name="email"]'
        password: '[name="password"]'
        submit: 'button[type="submit"]'
      success:
        urlContains: /dashboard
`);

    expect(() => resolveAuthProfile(config, "admin", {})).toThrow(ConfigValidationError);
  });

  it("rejects literal auth credentials", () => {
    const config = parseQAgentConfig(`
project:
  name: lms
target:
  environment: local
auth:
  profiles:
    admin:
      loginUrl: /login
      credentials:
        username: admin@test.local
        password: Password123!
      selectors:
        username: '[name="email"]'
        password: '[name="password"]'
        submit: 'button[type="submit"]'
      success:
        urlContains: /dashboard
`);

    expect(() => resolveAuthProfile(config, "admin", {})).toThrow(ConfigValidationError);
  });
});
