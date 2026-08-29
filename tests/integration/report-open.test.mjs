import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createConfigFromOverrides } from "#config";
import { RunOrchestrator } from "#core";
import { FileReporter } from "#reporting";
import { SqliteRunStore } from "#storage";

test("S15 report open resolves generated report paths from SQLite metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-report-open-"));
  const dbPath = join(root, "qagent.sqlite");
  const artifactRoot = join(root, "runs");
  const config = createConfigFromOverrides({
    cwd: root,
    urlOverride: "http://localhost:3000"
  });
  config.project.name = "report-open";
  config.tests.layers = ["config"];

  const outcome = await new RunOrchestrator(new SqliteRunStore(dbPath), new FileReporter()).run({
    config,
    mode: "cloud",
    cwd: root,
    artifactRoot,
    url: "http://localhost:3000"
  });

  const payload = JSON.parse(
    await cliJson(root, [
      resolve("dist/apps/cli/src/index.js"),
      "report",
      "open",
      outcome.runId,
      "--db",
      dbPath,
      "--json"
    ])
  );

  assert.equal(payload.runId, outcome.runId);
  assert.equal(payload.htmlPath.endsWith("report.html"), true);
  assert.equal(payload.existing.htmlPath, true);
  assert.equal(payload.existing.jsonPath, true);
  assert.equal(payload.existing.xlsxPath, true);
});

async function cliJson(cwd, args) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
  assert.equal(code, 0, stderr);
  return stdout.trim();
}
