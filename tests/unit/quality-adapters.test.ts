import { describe, expect, it } from "vitest";
import { parseQAgentConfig } from "#config";
import type { BaselineRecord, Finding, RunReportData } from "#contracts";
import { createRegressionComparison } from "#regression";
import {
  accessibilitySeverity,
  AxeAccessibilityAdapter,
  BrowserPerformanceAdapter,
  evaluateAccessibilityGate,
  evaluateLoadGate,
  evaluatePassiveSecurityGate,
  evaluatePerformanceGate,
  HttpLoadSmokeAdapter,
  loadFindingFingerprint,
  normalizeAxeResults,
  normalizeAxeViolation,
  normalizeBrowserTiming,
  normalizePassiveSecurityObservation,
  PassiveSecurityAdapter,
  performanceFindingFingerprint,
  QualityAdapterRegistry,
  securityFindingFingerprint,
  selectAccessibilityTargets,
  selectLoadTargets,
  selectPerformanceTargets,
  selectSecurityTargets,
  summarizeLoadSamples
} from "#quality-adapters";

describe("quality adapter registry", () => {
  it("orders adapters deterministically and rejects duplicate IDs", () => {
    const adapter = new AxeAccessibilityAdapter();
    const performance = new BrowserPerformanceAdapter();
    const security = new PassiveSecurityAdapter();
    const load = new HttpLoadSmokeAdapter();
    const registry = new QualityAdapterRegistry([performance, security, load, adapter]);

    expect(registry.list().map((item) => item.id)).toEqual(["axe-accessibility", "browser-performance", "http-load-smoke", "passive-security"]);
    expect(registry.byCategory("accessibility")[0].id).toBe("axe-accessibility");
    expect(registry.byCategory("performance")[0].id).toBe("browser-performance");
    expect(registry.byCategory("security")[0].id).toBe("passive-security");
    expect(registry.byCategory("load")[0].id).toBe("http-load-smoke");
    expect(() => registry.register(adapter)).toThrow(/Duplicate quality adapter id/);
  });

  it("reports unavailable adapters cleanly", () => {
    const adapter = new AxeAccessibilityAdapter({ unavailableReason: "missing axe-core" });

    expect(adapter.availability()).toEqual({ status: "UNAVAILABLE", reason: "missing axe-core" });
  });
});

describe("browser performance normalization", () => {
  it("normalizes timing metrics and applies configured thresholds", () => {
    const config = testConfig().performance;
    config.thresholds = {
      maxFirstByteMs: 100,
      maxDomContentLoadedMs: 200,
      maxLoadEventMs: 300,
      maxTransferSizeBytes: 1000,
      maxResourceCount: 3
    };
    const measurement = normalizeBrowserTiming(
      {
        responseStart: 120.4,
        domContentLoadedEventEnd: 199.6,
        loadEventEnd: 350.2,
        transferSize: 700,
        resourceCount: 4,
        resourceTransferSize: 450
      },
      "http://example.test/slow?token=secret"
    );
    const gate = evaluatePerformanceGate(measurement, config);

    expect(measurement.pageUrl).toBe("http://example.test/slow");
    expect(measurement.firstByteMs).toBe(120);
    expect(gate.passed).toBe(false);
    expect(gate.breaches.map((breach) => breach.metric)).toEqual(["maxFirstByteMs", "maxLoadEventMs", "maxTransferSizeBytes", "maxResourceCount"]);
  });

  it("creates stable performance finding fingerprints without query strings", () => {
    const measurement = normalizeBrowserTiming({ responseStart: 10 }, "http://example.test/dashboard?token=one");
    const same = normalizeBrowserTiming({ responseStart: 20 }, "http://example.test/dashboard?token=two");
    const breach = { metric: "maxFirstByteMs", actual: 1200, threshold: 1000 } as const;

    expect(performanceFindingFingerprint(measurement, breach)).toBe(performanceFindingFingerprint(same, breach));
  });
});

describe("passive security normalization", () => {
  it("normalizes passive observations and applies configured failOn checks", () => {
    const config = testConfig().security;
    config.failOn = ["content-security-policy", "cookie-http-only", "cookie-secure", "cookie-same-site"];
    const observation = normalizePassiveSecurityObservation(
      {
        pageUrl: "https://example.test/login?token=secret",
        statusCode: 200,
        headers: {
          "X-Content-Type-Options": "sniff",
          "Set-Cookie": "sid=secret"
        },
        setCookie: ["sid=secret; Path=/"]
      },
      config
    );
    const gate = evaluatePassiveSecurityGate(observation, config);

    expect(observation.pageUrl).toBe("https://example.test/login");
    expect(observation.headers["set-cookie"]).toBeUndefined();
    expect(observation.cookies[0].name).toBe("sid");
    expect(observation.cookies[0].httpOnly).toBe(false);
    expect(gate.passed).toBe(false);
    expect(gate.breaches.map((breach) => breach.check)).toEqual(["content-security-policy", "cookie-http-only", "cookie-same-site", "cookie-secure"]);
  });

  it("creates stable security finding fingerprints without query strings", () => {
    const config = testConfig().security;
    const first = normalizePassiveSecurityObservation({ pageUrl: "http://example.test/app?token=one", statusCode: 200, headers: {}, setCookie: [] }, config);
    const second = normalizePassiveSecurityObservation({ pageUrl: "http://example.test/app?token=two", statusCode: 200, headers: {}, setCookie: [] }, config);
    const issue = first.issues.find((item) => item.check === "content-security-policy");

    expect(issue).toBeDefined();
    expect(securityFindingFingerprint(first, issue!)).toBe(securityFindingFingerprint(second, issue!));
  });
});

describe("HTTP load smoke normalization", () => {
  it("summarizes samples and applies configured thresholds", () => {
    const config = testConfig().load;
    config.thresholds = {
      maxErrorRate: 0,
      maxAverageMs: 100,
      maxP95Ms: 150
    };
    const measurement = summarizeLoadSamples("http://example.test/api?token=secret", [
      { statusCode: 200, durationMs: 50, ok: true },
      { statusCode: 200, durationMs: 100, ok: true },
      { statusCode: 500, durationMs: 200, ok: false }
    ]);
    const gate = evaluateLoadGate(measurement, config);

    expect(measurement.pageUrl).toBe("http://example.test/api");
    expect(measurement.totalRequests).toBe(3);
    expect(measurement.failedRequests).toBe(1);
    expect(measurement.averageMs).toBe(117);
    expect(gate.passed).toBe(false);
    expect(gate.breaches.map((breach) => breach.metric)).toEqual(["maxErrorRate", "maxAverageMs", "maxP95Ms"]);
  });

  it("creates stable load finding fingerprints without query strings", () => {
    const first = summarizeLoadSamples("http://example.test/api?token=one", [{ statusCode: 500, durationMs: 10, ok: false }]);
    const second = summarizeLoadSamples("http://example.test/api?token=two", [{ statusCode: 500, durationMs: 20, ok: false }]);
    const breach = { metric: "maxErrorRate", actual: 1, threshold: 0 } as const;

    expect(loadFindingFingerprint(first, breach)).toBe(loadFindingFingerprint(second, breach));
  });
});

describe("axe accessibility normalization", () => {
  it("maps axe impact into deterministic QAgent severity", () => {
    expect(accessibilitySeverity("critical")).toBe("Critical");
    expect(accessibilitySeverity("serious")).toBe("High");
    expect(accessibilitySeverity("moderate")).toBe("Medium");
    expect(accessibilitySeverity("minor")).toBe("Low");
    expect(accessibilitySeverity("none")).toBe("Info");
  });

  it("normalizes violations with stable identity and sanitized bounded snippets", () => {
    const violation = normalizeAxeViolation({
      violation: axeViolation("image-alt", "serious"),
      node: {
        html: '<input id="token" value="super-secret-token" data-api-token="abc">',
        target: ["#token"],
        impact: "serious",
        any: [],
        all: [],
        none: [],
        failureSummary: "Fix token=super-secret-token"
      },
      pageUrl: "http://example.test/dashboard?token=secret",
      redactHeaders: ["authorization", "cookie"],
      secretValues: ["super-secret-token"]
    });
    const same = normalizeAxeViolation({
      violation: axeViolation("image-alt", "serious"),
      node: {
        html: '<input id="token" value="super-secret-token" data-api-token="abc">',
        target: ["#token"],
        impact: "serious",
        any: [],
        all: [],
        none: []
      },
      pageUrl: "http://example.test/dashboard?token=other",
      redactHeaders: ["authorization", "cookie"],
      secretValues: ["super-secret-token"]
    });

    expect(violation.fingerprint).toBe(same.fingerprint);
    expect(violation.html).not.toContain("super-secret-token");
    expect(violation.html).not.toContain('data-api-token="abc"');
    expect(violation.failureSummary).not.toContain("super-secret-token");
    expect(violation.severity).toBe("High");
  });

  it("limits nodes per axe rule", () => {
    const config = testConfig().accessibility;
    config.maxNodesPerRule = 1;
    const violations = normalizeAxeResults({
      raw: {
        violations: [
          {
            ...axeViolation("label", "critical"),
            nodes: [
              { html: "<input>", target: ["#one"], impact: "critical", any: [], all: [], none: [] },
              { html: "<input>", target: ["#two"], impact: "critical", any: [], all: [], none: [] }
            ]
          }
        ]
      },
      pageUrl: "http://example.test/",
      config,
      redactHeaders: [],
      secretValues: []
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].target).toBe("#one");
  });

  it("applies default critical/serious gate while allowing minor issues", () => {
    const config = testConfig().accessibility;
    const minor = {
      fingerprint: "minor",
      ruleId: "duplicate-id",
      impact: "minor",
      severity: "Low",
      description: "",
      help: "",
      helpUrl: "",
      pageUrl: "http://example.test/",
      target: "#duplicate",
      html: "",
      failureSummary: ""
    } as const;
    const serious = { ...minor, fingerprint: "serious", ruleId: "button-name", impact: "serious", severity: "High" } as const;

    expect(evaluateAccessibilityGate([minor], config).passed).toBe(true);
    expect(evaluateAccessibilityGate([serious], config).passed).toBe(false);
  });
});

describe("accessibility page selection", () => {
  it("uses include/exclude and maxPages without leaving allowed scope", () => {
    const config = testConfig(`
accessibility:
  include: [/, /login, /logout, http://external.test/]
  exclude: [/logout]
  maxPages: 2
tests:
  layers: [accessibility]
`);

    const targets = selectAccessibilityTargets({
      config,
      baseUrl: "http://example.test/",
      discoveredPages: [],
      profileName: "public"
    });

    expect(targets.map((target) => new URL(target.url).pathname)).toEqual(["/", "/login"]);
  });

  it("falls back to discovered pages when include is omitted", () => {
    const config = testConfig(`
accessibility:
  maxPages: 1
tests:
  layers: [accessibility]
`);

    const targets = selectAccessibilityTargets({
      config,
      baseUrl: "http://example.test/",
      discoveredPages: [
        discovered("http://example.test/second"),
        discovered("http://example.test/first")
      ],
      profileName: "public"
    });

    expect(targets).toHaveLength(1);
    expect(new URL(targets[0].url).pathname).toBe("/first");
  });
});

describe("performance page selection", () => {
  it("uses include/exclude/maxPages independently from accessibility config", () => {
    const config = testConfig(`
performance:
  include: [/, /slow, /logout, http://external.test/]
  exclude: [/logout]
  maxPages: 2
tests:
  layers: [performance]
`);

    const targets = selectPerformanceTargets({
      config,
      baseUrl: "http://example.test/",
      discoveredPages: []
    });

    expect(targets.map((target) => new URL(target.url).pathname)).toEqual(["/", "/slow"]);
  });

  it("normalizes allowed host entries consistently with target safety", () => {
    const config = testConfig(`
performance:
  include: [http://example.test./fast]
tests:
  layers: [performance]
`);
    config.target.allowed_hosts = ["Example.TEST."];

    const targets = selectPerformanceTargets({
      config,
      baseUrl: "http://example.test/",
      discoveredPages: []
    });

    expect(targets.map((target) => target.url)).toEqual(["http://example.test/fast"]);
  });
});

describe("security page selection", () => {
  it("uses include/exclude/maxPages independently from other quality configs", () => {
    const config = testConfig(`
security:
  include: [/, /settings, /logout, http://external.test/]
  exclude: [/logout]
  maxPages: 2
tests:
  layers: [security]
`);

    const targets = selectSecurityTargets({
      config,
      baseUrl: "http://example.test/",
      discoveredPages: []
    });

    expect(targets.map((target) => new URL(target.url).pathname)).toEqual(["/", "/settings"]);
  });
});

describe("load page selection", () => {
  it("uses include/exclude/maxPages independently from other quality configs", () => {
    const config = testConfig(`
load:
  include: [/, /api, /logout, http://external.test/]
  exclude: [/logout]
  maxPages: 2
tests:
  layers: [load]
`);

    const targets = selectLoadTargets({
      config,
      baseUrl: "http://example.test/",
      discoveredPages: []
    });

    expect(targets.map((target) => new URL(target.url).pathname)).toEqual(["/", "/api"]);
  });
});

describe("accessibility regression matching", () => {
  it("marks new and resolved accessibility findings by stable fingerprint", () => {
    const baseline: BaselineRecord = {
      id: "baseline_a11y",
      projectId: "project_1",
      runId: "run_baseline",
      name: "stable",
      createdAt: "2026-08-28T00:00:00.000Z"
    };
    const fixedFinding = finding("fixed-fingerprint", "image-alt");
    const newFinding = finding("new-fingerprint", "button-name");
    const comparison = createRegressionComparison({
      baseline,
      baselineReport: report("run_baseline", [fixedFinding]),
      currentReport: report("run_current", [newFinding])
    });

    expect(comparison.summary.newFindings).toBe(1);
    expect(comparison.summary.resolvedFindings).toBe(1);
    expect(comparison.findingEntries.find((entry) => entry.fingerprint === "new-fingerprint")?.classification).toBe("new-finding");
    expect(comparison.findingEntries.find((entry) => entry.fingerprint === "fixed-fingerprint")?.classification).toBe("resolved-finding");
  });
});

function testConfig(extra = "") {
  return parseQAgentConfig(`
project:
  name: a11y
target:
  environment: local
  url: http://example.test/
  allowed_hosts: [example.test]
${extra}
`);
}

function axeViolation(id: string, impact: "critical" | "serious" | "moderate" | "minor" | null) {
  return {
    id,
    impact,
    description: `${id} description`,
    help: `${id} help`,
    helpUrl: `https://example.test/${id}`,
    tags: [],
    nodes: []
  };
}

function discovered(url: string) {
  return {
    id: url,
    runId: "run",
    url,
    normalizedUrl: url,
    statusCode: 200,
    linkCount: 0,
    formCount: 0,
    buttonCount: 0,
    redirectCount: 0,
    consoleErrors: [],
    networkErrors: [],
    discoveredAt: "2026-08-28T00:00:00.000Z"
  };
}

function finding(fingerprint: string, ruleId: string): Finding {
  return {
    id: `finding:${fingerprint}`,
    fingerprint,
    category: "accessibility",
    severity: "High",
    title: `Accessibility violation: ${ruleId}`,
    description: `${ruleId} failed`,
    url: "http://example.test/dashboard",
    details: { ruleId, selector: "#target" },
    evidenceRefs: [],
    redactionApplied: true
  };
}

function report(runId: string, findings: Finding[]): RunReportData {
  return {
    project: { id: "project_1", name: "A11y", createdAt: "2026-08-28T00:00:00.000Z" },
    target: {
      id: "target_1",
      projectId: "project_1",
      mode: "cloud",
      url: "http://example.test/",
      environment: "local",
      allowedHosts: ["example.test"],
      createdAt: "2026-08-28T00:00:00.000Z"
    },
    run: {
      id: runId,
      projectId: "project_1",
      targetId: "target_1",
      status: "COMPLETED",
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: "2026-08-28T00:00:01.000Z",
      toolVersions: { qagent: "0.1.0" },
      artifactDir: ".qagent/runs/test",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:01.000Z"
    },
    sourceCommands: [],
    pages: [],
    apiEndpoints: [],
    authProfiles: [],
    registeredTests: [],
    results: [],
    findings,
    evidence: [],
    summary: {
      passed: true,
      total: 0,
      pass: 0,
      fail: 0,
      error: 0,
      blocked: 0,
      skipped: 0,
      durationMs: 1
    }
  };
}
