import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createConfigFromOverrides, loadQAgentConfig } from "#config";
import { RunOrchestrator } from "#core";
import { FileReporter } from "#reporting";
import { RuntimeSourceAdapter } from "#runtime-adapters";
import { SqliteRunStore } from "#storage";

const fixtureRoot = resolve(process.cwd(), "tests", "fixtures");

test("Source Mode executes Node lint/typecheck/test/build and persists reports", async () => {
  const { outcome, report } = await runSourceFixture("source-node-good");

  assert.equal(outcome.exitCode, 0);
  assert.equal(report.sourceProject.runtime, "node");
  assert.equal(report.sourceProject.framework, "vite");
  assert.equal(report.sourceProject.packageManager, "npm");
  assert.deepEqual(
    report.sourceCommands.map((command) => `${command.capability}:${command.status}`),
    ["lint:PASS", "typeCheck:PASS", "test:PASS", "build:PASS"]
  );
  assert.equal(existsSync(outcome.reportOutput.htmlPath), true);
  assert.equal(existsSync(outcome.reportOutput.junitPath), true);
  assert.equal(existsSync(join(outcome.reportOutput.rootDir, report.sourceCommands[0].stdoutArtifact)), true);
});

test("Source Mode maps a failing Node test script to a quality gate failure", async () => {
  const { outcome, report } = await runSourceFixture("source-node-failing-test");
  const sourceTest = report.results.find((result) => result.testKey === "source.test");

  assert.equal(outcome.exitCode, 1);
  assert.equal(sourceTest.status, "FAIL");
  assert.equal(report.sourceCommands[0].reason, "COMMAND_EXIT_NONZERO");
});

test("Source Mode maps a failing Node build script to a quality gate failure", async () => {
  const { outcome, report } = await runSourceFixture("source-node-build-failure");
  const sourceBuild = report.results.find((result) => result.testKey === "source.build");

  assert.equal(outcome.exitCode, 1);
  assert.equal(sourceBuild.status, "FAIL");
  assert.equal(report.sourceCommands.find((command) => command.capability === "build").reason, "COMMAND_EXIT_NONZERO");
});

test("Source Mode inspects Python projects and blocks cleanly when Python or pytest is unavailable", async () => {
  const { outcome, report } = await runSourceFixture("source-python-good");
  const sourceTest = report.results.find((result) => result.testKey === "source.test");

  assert.equal(report.sourceProject.runtime, "python");
  assert.ok([0, 1].includes(outcome.exitCode));
  assert.ok(["PASS", "BLOCKED"].includes(sourceTest.status));
  assert.notEqual(sourceTest.status, "ERROR");
});

test("Source Mode runs explicit Generic commands from qa.config.yaml", async () => {
  const sourcePath = join(fixtureRoot, "source-generic-good");
  const config = loadQAgentConfig({ cwd: sourcePath, sourcePath: ".", allowSourceCommands: true });
  const { outcome, report } = await runSource({ config, cwd: sourcePath, sourcePath: "." });

  assert.equal(outcome.exitCode, 0);
  assert.equal(report.sourceProject.adapterId, "generic");
  assert.deepEqual(
    report.sourceCommands.map((command) => `${command.capability}:${command.status}`),
    ["test:PASS", "build:PASS"]
  );
});

test("Source Mode blocks unsupported folders without crashing report generation", async () => {
  const { outcome, report } = await runSourceFixture("source-unknown");
  const select = report.results.find((result) => result.testKey === "source.adapter.select");

  assert.equal(outcome.exitCode, 1);
  assert.equal(report.sourceProject.support, "UNSUPPORTED");
  assert.equal(select.status, "BLOCKED");
  assert.equal(existsSync(outcome.reportOutput.htmlPath), true);
  assert.equal(existsSync(outcome.reportOutput.junitPath), true);
});

test("Source Mode redacts configured secret values from command evidence and reports", async () => {
  const sourcePath = mkdtempSync(join(tmpdir(), "qagent-source-secret-"));
  const secret = "source-secret-value";
  process.env.QAGENT_TEST_SECRET = secret;
  writeFileSync(
    join(sourcePath, "qa.config.yaml"),
    `
project:
  name: source-secret
target:
  environment: local
source:
  adapter: generic
  commands:
    test:
      executable: node
      args: ["-e", "console.log(process.env.QAGENT_TEST_SECRET)"]
safety:
  allow_source_commands: true
auth:
  profiles:
    admin:
      loginUrl: /login
      credentials:
        username: \${QAGENT_TEST_SECRET}
        password: \${QAGENT_TEST_SECRET}
      selectors:
        username: "#email"
        password: "#password"
        submit: "button"
      success:
        urlContains: /dashboard
tests:
  layers: [source]
`,
    "utf8"
  );

  try {
    const config = loadQAgentConfig({ cwd: sourcePath, sourcePath: ".", allowSourceCommands: true });
    const { outcome, report } = await runSource({ config, cwd: sourcePath, sourcePath: "." });
    const stdoutPath = join(outcome.reportOutput.rootDir, report.sourceCommands[0].stdoutArtifact);

    assert.equal(outcome.exitCode, 0);
    assert.equal(readFileSync(stdoutPath, "utf8").includes(secret), false);
    assert.equal(JSON.stringify(report).includes(secret), false);
  } finally {
    delete process.env.QAGENT_TEST_SECRET;
  }
});

async function runSourceFixture(name) {
  const sourcePath = join(fixtureRoot, name);
  const config = createConfigFromOverrides({ cwd: process.cwd(), sourcePath });
  config.tests.layers = ["source"];
  config.safety.allow_source_commands = true;
  return runSource({ config, cwd: process.cwd(), sourcePath });
}

async function runSource({ config, cwd, sourcePath }) {
  const root = mkdtempSync(join(tmpdir(), "qagent-source-run-"));
  const store = new SqliteRunStore(join(root, "qagent.sqlite"));
  const reporter = new FileReporter();
  const orchestrator = new RunOrchestrator(store, reporter, {
    sourceModeAdapter: new RuntimeSourceAdapter()
  });

  const outcome = await orchestrator.run({
    config,
    mode: "source",
    cwd,
    artifactRoot: join(root, "runs"),
    sourcePath,
    inspectOnly: !config.safety.allow_source_commands
  });
  const report = JSON.parse(readFileSync(outcome.reportOutput.jsonPath, "utf8"));
  return { outcome, report };
}
