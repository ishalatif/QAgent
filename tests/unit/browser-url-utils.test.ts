import { describe, expect, it } from "vitest";
import type { QAgentConfig } from "#contracts";
import { isCrawlableUrl, matchesExcludedPath, normalizeEndpointPath, normalizePageUrl } from "#browser-playwright";

describe("browser discovery URL utilities", () => {
  it("normalizes pages without query strings or fragments", () => {
    expect(normalizePageUrl("https://example.com/docs/?token=secret#top")).toBe("https://example.com/docs");
  });

  it("normalizes endpoint paths without query values", () => {
    expect(normalizeEndpointPath("https://example.com/api/users?token=secret")).toBe("/api/users");
  });

  it("enforces same-origin and exclude rules", () => {
    const config = baseConfig();

    expect(isCrawlableUrl("/about", "https://example.com", config)).toBe(true);
    expect(isCrawlableUrl("https://other.example.com", "https://example.com", config)).toBe(false);
    expect(isCrawlableUrl("/logout", "https://example.com", config)).toBe(false);
    expect(isCrawlableUrl("javascript:alert(1)", "https://example.com", config)).toBe(false);
  });

  it("matches simple path globs", () => {
    expect(matchesExcludedPath("/billing/invoices", ["/billing/*"])).toBe(true);
    expect(matchesExcludedPath("/profile", ["/billing/*"])).toBe(false);
  });
});

function baseConfig(): QAgentConfig {
  return {
    project: { name: "test" },
    target: { environment: "staging", url: "https://example.com", allowed_hosts: ["example.com"] },
    safety: { destructive: false, active_security_scan: false, load_test: false, max_concurrency: 3, allow_source_commands: false },
    auth: { profiles: {} },
    api: { assertions: [], authorization: [] },
    discovery: { max_pages: 10, max_depth: 2, same_origin_only: true, exclude: ["/logout"] },
    tests: { layers: ["browser", "api"], retries: 0 },
    permissions: {},
    report: { formats: ["html", "json", "junit"], evidence_on: "failure", redact_headers: ["authorization", "cookie", "set-cookie"] }
  };
}
