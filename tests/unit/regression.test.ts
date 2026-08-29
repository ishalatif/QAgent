import { describe, expect, it } from "vitest";
import type { BaselineRecord, NormalizedResult, ResultStatus, RunReportData } from "#contracts";
import { createRegressionComparison, RegressionComparisonError } from "#regression";

describe("regression comparison", () => {
  it("classifies new, resolved, changed, missing, and unchanged results", () => {
    const baseline: BaselineRecord = {
      id: "baseline_stable",
      projectId: "project_1",
      runId: "run_baseline",
      name: "stable",
      createdAt: "2026-08-28T00:00:00.000Z"
    };
    const comparison = createRegressionComparison({
      baseline,
      baselineReport: report("run_baseline", [
        result("config.schema", "PASS"),
        result("api.health", "FAIL"),
        result("auth.login", "PASS"),
        result("browser.dashboard", "PASS"),
        result("browser.missing", "FAIL")
      ]),
      currentReport: report("run_current", [
        result("config.schema", "PASS"),
        result("api.health", "PASS"),
        result("auth.login", "FAIL"),
        result("browser.dashboard", "SKIPPED"),
        result("browser.new", "FAIL")
      ]),
      comparedAt: "2026-08-28T01:00:00.000Z"
    });

    expect(comparison.summary).toMatchObject({
      passed: false,
      baselineTotal: 5,
      currentTotal: 5,
      comparedTotal: 6,
      unchanged: 1,
      newFailures: 2,
      resolvedFailures: 1,
      statusChanged: 1,
      missingTests: 1,
      regressions: 4,
      improvements: 1
    });
    expect(comparison.entries.find((entry) => entry.testKey === "api.health")?.classification).toBe("resolved-failure");
    expect(comparison.entries.find((entry) => entry.testKey === "auth.login")?.classification).toBe("new-failure");
    expect(comparison.entries.find((entry) => entry.testKey === "browser.dashboard")?.classification).toBe("status-changed");
    expect(comparison.entries.find((entry) => entry.testKey === "browser.missing")?.classification).toBe("missing-test");
    expect(comparison.entries.find((entry) => entry.testKey === "browser.new")?.classification).toBe("new-failure");
  });

  it("rejects incompatible project comparisons", () => {
    const baseline: BaselineRecord = {
      id: "baseline_stable",
      projectId: "project_1",
      runId: "run_baseline",
      name: "stable",
      createdAt: "2026-08-28T00:00:00.000Z"
    };

    expect(() =>
      createRegressionComparison({
        baseline,
        baselineReport: report("run_baseline", [], "project_1"),
        currentReport: report("run_current", [], "project_2")
      })
    ).toThrow(RegressionComparisonError);
  });
});

function report(runId: string, results: NormalizedResult[], projectId = "project_1"): RunReportData {
  return {
    project: {
      id: projectId,
      name: "QAgent Test",
      createdAt: "2026-08-28T00:00:00.000Z"
    },
    target: {
      id: `target_${projectId}`,
      projectId,
      mode: "cloud",
      url: "http://localhost:3000",
      environment: "local",
      allowedHosts: ["localhost"],
      createdAt: "2026-08-28T00:00:00.000Z"
    },
    run: {
      id: runId,
      projectId,
      targetId: `target_${projectId}`,
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
    results,
    findings: [],
    evidence: [],
    summary: {
      passed: true,
      total: results.length,
      pass: results.filter((item) => item.status === "PASS").length,
      fail: results.filter((item) => item.status === "FAIL").length,
      error: results.filter((item) => item.status === "ERROR").length,
      blocked: results.filter((item) => item.status === "BLOCKED").length,
      skipped: results.filter((item) => item.status === "SKIPPED").length,
      durationMs: 1000
    }
  };
}

function result(testKey: string, status: ResultStatus): NormalizedResult {
  return {
    id: `${testKey}:${status}`,
    runId: "test-run",
    testKey,
    layer: testKey.startsWith("api.") ? "api" : "browser",
    title: testKey,
    status,
    startedAt: "2026-08-28T00:00:00.000Z",
    durationMs: 1,
    targetRef: "http://localhost:3000",
    error: status === "FAIL" ? `${testKey} failed` : undefined,
    evidenceRefs: [],
    findingRefs: [],
    adapterId: "test",
    adapterVersion: "0.0.0"
  };
}
