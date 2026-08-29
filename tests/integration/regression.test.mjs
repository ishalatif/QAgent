import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createConfigFromOverrides } from "#config";
import { RunOrchestrator } from "#core";
import { FileReporter } from "#reporting";
import { SqliteRunStore } from "#storage";

test("S7 baseline create and compare produce regression diff exports", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-regression-"));
  const dbPath = join(root, "qagent.sqlite");
  const artifactRoot = join(root, "runs");
  const baselineRun = await runWithBrowserResult(root, dbPath, artifactRoot, "smoke.checkout", "PASS");
  const currentRun = await runWithBrowserResult(root, dbPath, artifactRoot, "smoke.checkout", "FAIL");

  assert.equal(existsSync(baselineRun.reportOutput.xlsxPath), true);
  assertXlsxArchive(baselineRun.reportOutput.xlsxPath);

  const cli = resolve("dist/apps/cli/src/index.js");
  const create = spawnSync(process.execPath, [cli, "baseline", "create", "--run", baselineRun.runId, "--name", "stable", "--db", dbPath], {
    encoding: "utf8"
  });
  assert.equal(create.status, 0, create.stderr || create.stdout);
  assert.match(create.stdout, /Baseline: stable/);

  const outputRoot = join(root, "comparisons");
  const compare = spawnSync(
    process.execPath,
    [cli, "compare", "--run", currentRun.runId, "--baseline", "stable", "--db", dbPath, "--output", outputRoot],
    { encoding: "utf8" }
  );
  assert.equal(compare.status, 1, compare.stderr || compare.stdout);
  assert.match(compare.stdout, /newFailures=1/);
  assert.match(compare.stdout, /regression gate failed/);

  const [comparisonDir] = readdirSync(outputRoot);
  const comparisonRoot = join(outputRoot, comparisonDir);
  const comparison = JSON.parse(readFileSync(join(comparisonRoot, "comparison.json"), "utf8"));

  assert.equal(existsSync(join(comparisonRoot, "comparison.html")), true);
  assertXlsxArchive(join(comparisonRoot, "comparison.xlsx"));
  assert.equal(comparison.summary.passed, false);
  assert.equal(comparison.summary.newFailures, 1);
  assert.equal(comparison.entries.find((entry) => entry.testKey === "smoke.checkout").classification, "new-failure");
});

async function runWithBrowserResult(root, dbPath, artifactRoot, testKey, status) {
  const config = createConfigFromOverrides({
    cwd: root,
    urlOverride: "http://localhost:3000"
  });
  config.tests.layers = ["browser"];

  const store = new SqliteRunStore(dbPath);
  const reporter = new FileReporter();
  const orchestrator = new RunOrchestrator(store, reporter, {
    cloudDiscoveryAdapter: fakeDiscoveryAdapter(testKey, status)
  });

  return orchestrator.run({
    config,
    mode: "cloud",
    cwd: root,
    artifactRoot,
    url: "http://localhost:3000"
  });
}

function fakeDiscoveryAdapter(testKey, status) {
  return {
    id: "regression-fixture",
    version: "0.0.0",
    async discover(request) {
      return {
        pages: [],
        apiEndpoints: [],
        findings: [],
        evidence: [],
        sourceCommands: [],
        authProfiles: [],
        registeredTests: [],
        results: [
          {
            id: `${request.runId}:${testKey}`,
            runId: request.runId,
            testKey,
            layer: "browser",
            title: "Checkout smoke",
            status,
            startedAt: new Date().toISOString(),
            durationMs: 1,
            targetRef: request.url,
            error: status === "FAIL" ? "checkout failed" : undefined,
            evidenceRefs: [],
            findingRefs: [],
            adapterId: "regression-fixture",
            adapterVersion: "0.0.0"
          }
        ]
      };
    }
  };
}

function assertXlsxArchive(path) {
  const data = readFileSync(path);
  assert.equal(data.subarray(0, 2).toString(), "PK");
  assert.equal(data.includes(Buffer.from("xl/workbook.xml")), true);
}
