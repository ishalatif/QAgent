import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createConfigFromOverrides } from "#config";
import { RunOrchestrator } from "#core";
import { startDashboardServer } from "#dashboard";
import { FileReporter } from "#reporting";
import { SqliteRunStore } from "#storage";

test("S9 dashboard beta serves projects, runs, reports, findings, and evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-dashboard-"));
  const dbPath = join(root, "qagent.sqlite");
  const artifactRoot = join(root, "runs");
  const config = createConfigFromOverrides({
    cwd: root,
    urlOverride: "http://localhost:3000"
  });
  config.project.name = "dashboard-fixture";

  const orchestrator = new RunOrchestrator(new SqliteRunStore(dbPath), new FileReporter(), {
    cloudDiscoveryAdapter: {
      id: "dashboard-fixture-adapter",
      version: "0.0.0",
      async discover(request) {
        const relativePath = "evidence/dashboard-fixture.json";
        const absolutePath = join(request.artifactDir, relativePath);
        const content = JSON.stringify({ message: "fixture evidence" }, null, 2);
        mkdirSync(join(request.artifactDir, "evidence"), { recursive: true });
        writeFileSync(absolutePath, `${content}\n`, "utf8");
        const evidence = {
          id: `${request.runId}:evidence:dashboard-fixture`,
          type: "json",
          relativePath,
          sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
          size: readFileSync(absolutePath).length
        };
        const finding = {
          id: `${request.runId}:finding:dashboard-fixture`,
          fingerprint: "dashboard-fixture-finding",
          category: "browser",
          severity: "High",
          title: "Dashboard fixture finding",
          description: "A deterministic finding for dashboard review.",
          url: request.url,
          evidenceRefs: [evidence],
          redactionApplied: true
        };

        return {
          pages: [
            {
              id: `${request.runId}:page:home`,
              runId: request.runId,
              url: request.url,
              normalizedUrl: request.url,
              finalUrl: request.url,
              statusCode: 200,
              title: "Dashboard Fixture",
              linkCount: 1,
              formCount: 0,
              buttonCount: 1,
              redirectCount: 0,
              consoleErrors: [],
              networkErrors: [],
              discoveredAt: new Date().toISOString()
            }
          ],
          apiEndpoints: [],
          findings: [finding],
          evidence: [evidence],
          sourceCommands: [],
          authProfiles: [],
          registeredTests: [],
          results: [
            {
              id: `${request.runId}:result:dashboard-fixture`,
              runId: request.runId,
              testKey: "dashboard.fixture",
              layer: "browser",
              title: "Dashboard fixture result",
              status: "FAIL",
              startedAt: new Date().toISOString(),
              durationMs: 5,
              targetRef: request.url,
              evidenceRefs: [evidence],
              findingRefs: [finding.id],
              adapterId: "dashboard-fixture-adapter",
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
    artifactRoot,
    url: "http://localhost:3000"
  });
  assert.equal(outcome.exitCode, 1);

  const server = await startDashboardServer({ dbPath, port: 0 });
  try {
    const html = await text(server.url, "/");
    assert.match(html, /QAgent Dashboard/);
    assert.match(html, /Dashboard beta/);

    const health = await api(server.url, "/health");
    assert.equal(health.ok, true);
    assert.equal(health.diagnostics.database.exists, true);

    const projects = await api(server.url, "/api/v1/projects");
    assert.equal(projects.length, 1);
    assert.equal(projects[0].project.name, "dashboard-fixture");
    assert.equal(projects[0].runCount, 1);

    const runs = await api(server.url, "/api/v1/runs");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].run.id, outcome.runId);
    assert.equal(runs[0].findingCount, 1);
    assert.equal(runs[0].evidenceCount, 1);

    const overview = await api(server.url, `/api/v1/runs/${encodeURIComponent(outcome.runId)}`);
    assert.equal(overview.resultCount, 3);
    assert.equal(overview.failedResultCount, 1);

    const report = await api(server.url, `/api/v1/runs/${encodeURIComponent(outcome.runId)}/report`);
    assert.equal(report.run.id, outcome.runId);
    assert.equal(report.results.some((result) => result.testKey === "dashboard.fixture"), true);
    assert.equal(report.findings[0].title, "Dashboard fixture finding");
    assert.equal(report.evidence.length, 1);

    const findings = await api(server.url, `/api/v1/findings?runId=${encodeURIComponent(outcome.runId)}&severity=High`);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fingerprint, "dashboard-fixture-finding");

    const evidence = await fetch(`${server.url}/api/v1/evidence/${encodeURIComponent(report.evidence[0].id)}`);
    assert.equal(evidence.status, 200);
    assert.match(await evidence.text(), /fixture evidence/);
  } finally {
    await server.close();
  }
});

test("S9 dashboard beta returns empty read models when the database is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-dashboard-empty-"));
  const dbPath = join(root, "missing.sqlite");
  const server = await startDashboardServer({ dbPath, port: 0 });
  try {
    assert.equal(existsSync(dbPath), false);
    const health = await api(server.url, "/health");
    assert.equal(health.diagnostics.database.exists, false);
    assert.deepEqual(await api(server.url, "/api/v1/projects"), []);
    assert.deepEqual(await api(server.url, "/api/v1/runs"), []);

    const missing = await fetch(`${server.url}/api/v1/runs/missing/report`);
    const payload = await missing.json();
    assert.equal(missing.status, 404);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, "DATABASE_NOT_FOUND");

    const malformed = await fetch(`${server.url}/api/v1/runs/%E0%A4%A/report`);
    const malformedPayload = await malformed.json();
    assert.equal(malformed.status, 400);
    assert.equal(malformedPayload.error.code, "INVALID_PATH");

    const disabledTrigger = await fetch(`${server.url}/api/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://example.test" })
    });
    const disabledPayload = await disabledTrigger.json();
    assert.equal(disabledTrigger.status, 403);
    assert.equal(disabledPayload.error.code, "RUN_TRIGGER_DISABLED");
  } finally {
    await server.close();
  }
});

test("S14 dashboard run trigger API validates input and calls the opt-in runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-dashboard-trigger-"));
  const dbPath = join(root, "qagent.sqlite");
  let received;
  const server = await startDashboardServer({
    dbPath,
    port: 0,
    runTrigger: {
      enabled: true,
      async trigger(request) {
        received = request;
        return {
          runId: "run_triggered",
          status: "COMPLETED",
          exitCode: 0,
          summary: {
            passed: true,
            total: 1,
            pass: 1,
            fail: 0,
            error: 0,
            blocked: 0,
            skipped: 0,
            durationMs: 1
          },
          reportOutput: {
            runId: "run_triggered",
            rootDir: join(root, "runs", "run_triggered")
          }
        };
      }
    }
  });

  try {
    const diagnostics = await api(server.url, "/api/v1/system/diagnostics");
    assert.equal(diagnostics.server.mode, "local-trigger-enabled");

    const response = await fetch(`${server.url}/api/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "http://example.test",
        layers: ["security"],
        profile: "admin"
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.success, true);
    assert.equal(payload.data.runId, "run_triggered");
    assert.deepEqual(received, {
      url: "http://example.test",
      sourcePath: undefined,
      configPath: undefined,
      profile: "admin",
      layers: ["security"],
      allowSourceCommands: undefined,
      inspectOnly: undefined
    });

    const invalid = await fetch(`${server.url}/api/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://example.test", sourcePath: "." })
    });
    const invalidPayload = await invalid.json();
    assert.equal(invalid.status, 400);
    assert.equal(invalidPayload.error.code, "INVALID_RUN_TRIGGER");
  } finally {
    await server.close();
  }
});

test("S9 dashboard CLI command starts the local dashboard", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-dashboard-cli-"));
  const dbPath = join(root, "qagent.sqlite");
  const cli = resolve("dist/apps/cli/src/index.js");
  const child = spawn(process.execPath, [cli, "dashboard", "--db", dbPath, "--port", "0", "--json"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const payload = JSON.parse(await firstStdoutLine(child));
    assert.match(payload.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(payload.dbPath, dbPath);
    const health = await api(payload.url, "/health");
    assert.equal(health.ok, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
  }
});

async function api(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
  const payload = await response.json();
  assert.equal(payload.success, true, JSON.stringify(payload));
  return payload.data;
}

async function text(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "text/html" } });
  assert.equal(response.status, 200);
  return response.text();
}

async function firstStdoutLine(child) {
  let output = "";
  return new Promise((resolveLine, rejectLine) => {
    const timeout = setTimeout(() => rejectLine(new Error("dashboard CLI did not print a ready line")), 5000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const line = output.split(/\r?\n/).find(Boolean);
      if (line) {
        clearTimeout(timeout);
        resolveLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      clearTimeout(timeout);
      rejectLine(new Error(String(chunk)));
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      rejectLine(new Error(`dashboard CLI exited before ready: ${code}`));
    });
  });
}
