import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfigFromOverrides } from "#config";
import { RunOrchestrator } from "#core";
import { FileReporter } from "#reporting";
import { SqliteRunStore } from "#storage";

test("foundation run persists metadata and writes reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-run-"));
  const config = createConfigFromOverrides({
    cwd: root,
    urlOverride: "http://localhost:3000"
  });

  const store = new SqliteRunStore(join(root, "qagent.sqlite"));
  const reporter = new FileReporter();
  const orchestrator = new RunOrchestrator(store, reporter);

  const outcome = await orchestrator.run({
    config,
    mode: "cloud",
    cwd: root,
    artifactRoot: join(root, "runs"),
    url: "http://localhost:3000"
  });

  assert.equal(outcome.exitCode, 0);
  assert.ok(outcome.summary.pass > 0);
  assert.ok(outcome.summary.skipped > 0);
  assert.equal(existsSync(outcome.reportOutput.jsonPath), true);
  assert.equal(existsSync(outcome.reportOutput.htmlPath), true);
  assert.equal(existsSync(outcome.reportOutput.junitPath), true);

  const report = JSON.parse(readFileSync(outcome.reportOutput.jsonPath, "utf8"));
  assert.equal(report.run.id, outcome.runId);
  assert.equal(report.run.status, "COMPLETED");
  assert.equal(report.summary.passed, true);
});

test("cloud discovery adapter output is persisted in the run report", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-run-"));
  const config = createConfigFromOverrides({
    cwd: root,
    urlOverride: "http://localhost:3000"
  });
  const store = new SqliteRunStore(join(root, "qagent.sqlite"));
  const reporter = new FileReporter();
  const orchestrator = new RunOrchestrator(store, reporter, {
    cloudDiscoveryAdapter: {
      id: "fake-browser",
      version: "0.0.0",
      async discover(request) {
        return {
          pages: [
            {
              id: `${request.runId}:page:home`,
              runId: request.runId,
              url: request.url,
              normalizedUrl: request.url,
              statusCode: 200,
              title: "Home",
              linkCount: 1,
              formCount: 0,
              buttonCount: 0,
              redirectCount: 0,
              consoleErrors: [],
              networkErrors: [],
              discoveredAt: new Date().toISOString()
            }
          ],
          apiEndpoints: [
            {
              id: `${request.runId}:endpoint:api`,
              runId: request.runId,
              method: "GET",
              normalizedPath: "/api/data",
              statusCodes: [200],
              count: 1,
              firstSeenAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString()
            }
          ],
          findings: [],
          evidence: [],
          sourceCommands: [],
          authProfiles: [],
          registeredTests: [],
          results: [
            {
              id: `${request.runId}:result:discovery`,
              runId: request.runId,
              testKey: "cloud.discovery.crawl",
              layer: "browser",
              title: "Fake discovery",
              status: "PASS",
              startedAt: new Date().toISOString(),
              durationMs: 1,
              targetRef: request.url,
              evidenceRefs: [],
              findingRefs: [],
              adapterId: "fake-browser",
              adapterVersion: "0.0.0"
            }
          ]
        };
      }
    }
  });

  const outcome = await orchestrator.run({
    config,
    mode: "cloud",
    cwd: root,
    artifactRoot: join(root, "runs"),
    url: "http://localhost:3000"
  });
  const report = JSON.parse(readFileSync(outcome.reportOutput.jsonPath, "utf8"));

  assert.equal(report.pages.length, 1);
  assert.equal(report.apiEndpoints[0].normalizedPath, "/api/data");
  assert.equal(report.results.some((result) => result.adapterId === "fake-browser"), true);
});

test("adapter crashes are persisted as ERROR results and reports are still written", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-run-"));
  const config = createConfigFromOverrides({
    cwd: root,
    urlOverride: "http://localhost:3000"
  });
  const store = new SqliteRunStore(join(root, "qagent.sqlite"));
  const reporter = new FileReporter();
  const orchestrator = new RunOrchestrator(store, reporter, {
    cloudDiscoveryAdapter: {
      id: "crashy-browser",
      version: "0.0.0",
      async discover() {
        throw new Error("adapter exploded token=secret");
      }
    }
  });

  const outcome = await orchestrator.run({
    config,
    mode: "cloud",
    cwd: root,
    artifactRoot: join(root, "runs"),
    url: "http://localhost:3000"
  });
  const report = JSON.parse(readFileSync(outcome.reportOutput.jsonPath, "utf8"));
  const errorResult = report.results.find((result) => result.testKey === "cloud.discovery.adapter");

  assert.equal(outcome.exitCode, 1);
  assert.equal(report.summary.error, 1);
  assert.equal(errorResult.status, "ERROR");
  assert.equal(JSON.stringify(report).includes("token=secret"), false);
  assert.equal(existsSync(outcome.reportOutput.htmlPath), true);
  assert.equal(existsSync(outcome.reportOutput.junitPath), true);
});
