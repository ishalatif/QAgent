import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { createConfigFromOverrides } from "#config";
import { RunOrchestrator } from "#core";
import { FileReporter } from "#reporting";
import { SqliteRunStore } from "#storage";
import { AxeAccessibilityAdapter } from "#quality-adapters";
import { PlaywrightBrowserTestAdapter } from "#browser-playwright";

test("S8 accessibility good fixture passes and exports reports", async () => {
  const fixture = await startFixture("tests/fixtures/accessibility-good-server.mjs");
  try {
    const { outcome, report } = await runAccessibility(fixture.url, {
      projectName: "a11y-good",
      include: ["/"]
    });

    assert.equal(outcome.exitCode, 0);
    assert.equal(report.results.find((result) => result.testKey === "accessibility.axe.public.home").status, "PASS");
    assert.equal(report.findings.filter((finding) => finding.category === "accessibility").length, 0);
    assert.equal(existsSync(outcome.reportOutput.htmlPath), true);
    assert.equal(existsSync(outcome.reportOutput.junitPath), true);
    assertXlsxArchive(outcome.reportOutput.xlsxPath);
    assert.match(readFileSync(outcome.reportOutput.htmlPath, "utf8"), /Accessibility Summary/);
  } finally {
    await fixture.stop();
  }
});

test("S8 accessibility bad fixture fails, normalizes findings, and writes bounded evidence", async () => {
  const fixture = await startFixture("tests/fixtures/accessibility-bad-server.mjs");
  try {
    const { outcome, report } = await runAccessibility(fixture.url, {
      projectName: "a11y-bad",
      include: ["/"]
    });
    const a11yFindings = report.findings.filter((finding) => finding.category === "accessibility");

    assert.equal(outcome.exitCode, 1);
    assert.equal(report.results.find((result) => result.testKey === "accessibility.axe.public.home").status, "FAIL");
    assert.ok(a11yFindings.length > 0);
    assert.equal(a11yFindings.some((finding) => finding.severity === "Critical" || finding.severity === "High"), true);
    assert.equal(a11yFindings.every((finding) => finding.details?.ruleId && finding.details?.selector), true);
    assert.equal(report.evidence.some((item) => item.relativePath === "evidence/accessibility/violations.json"), true);
    assert.equal(readFileSync(join(outcome.reportOutput.rootDir, "evidence/accessibility/violations.json"), "utf8").length < 30000, true);
  } finally {
    await fixture.stop();
  }
});

test("S8 non-blocking accessibility findings do not fail the default gate", async () => {
  const fixture = await startFixture("tests/fixtures/accessibility-bad-server.mjs");
  try {
    const { outcome, report } = await runAccessibility(fixture.url, {
      projectName: "a11y-minor",
      include: ["/minor"]
    });
    const a11yFindings = report.findings.filter((finding) => finding.category === "accessibility");

    assert.equal(outcome.exitCode, 0);
    assert.equal(report.results.find((result) => result.testKey === "accessibility.axe.public.minor").status, "PASS");
    assert.ok(a11yFindings.length > 0);
    assert.equal(a11yFindings.every((finding) => ["Medium", "Low", "Info"].includes(finding.severity)), true);
  } finally {
    await fixture.stop();
  }
});

test("S8 authenticated accessibility reuses saved session from browser auth", async () => {
  const fixture = await startFixture("tests/fixtures/accessibility-auth-server.mjs", {
    ADMIN_EMAIL: "admin@example.test",
    ADMIN_PASSWORD: "Password123!"
  });
  const previousEmail = process.env.ADMIN_EMAIL;
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_EMAIL = "admin@example.test";
  process.env.ADMIN_PASSWORD = "Password123!";
  try {
    const root = mkdtempSync(join(tmpdir(), "qagent-a11y-auth-"));
    const config = accessibilityConfig({
      root,
      url: fixture.url,
      projectName: "a11y-auth",
      include: ["/dashboard"],
      layers: ["browser", "accessibility"],
      profiles: ["admin"]
    });
    config.auth.profiles = authProfiles();

    const orchestrator = new RunOrchestrator(new SqliteRunStore(join(root, "qagent.sqlite")), new FileReporter(), {
      browserTestAdapter: new PlaywrightBrowserTestAdapter(),
      qualityAdapters: [new AxeAccessibilityAdapter()]
    });
    const outcome = await orchestrator.run({
      config,
      mode: "cloud",
      cwd: root,
      artifactRoot: join(root, "runs"),
      url: fixture.url,
      profile: "admin",
      testKeys: ["auth.valid-login"]
    });
    const report = JSON.parse(readFileSync(outcome.reportOutput.jsonPath, "utf8"));

    assert.equal(outcome.exitCode, 0);
    assert.equal(report.results.find((result) => result.testKey === "auth.valid-login").status, "PASS");
    assert.equal(report.results.find((result) => result.testKey === "accessibility.axe.admin.dashboard").status, "PASS");
    assert.equal(JSON.stringify(report).includes("Password123!"), false);
  } finally {
    restoreEnv("ADMIN_EMAIL", previousEmail);
    restoreEnv("ADMIN_PASSWORD", previousPassword);
    await fixture.stop();
  }
});

test("S8 authenticated accessibility blocks dependent scans when auth fails", async () => {
  const fixture = await startFixture("tests/fixtures/accessibility-auth-server.mjs", {
    QAGENT_AUTH_FAIL: "1",
    ADMIN_EMAIL: "admin@example.test",
    ADMIN_PASSWORD: "Password123!"
  });
  const previousEmail = process.env.ADMIN_EMAIL;
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_EMAIL = "admin@example.test";
  process.env.ADMIN_PASSWORD = "Password123!";
  try {
    const { outcome, report } = await runAccessibility(fixture.url, {
      projectName: "a11y-auth-fail",
      include: ["/dashboard"],
      profiles: ["admin"],
      auth: true
    });
    const result = report.results.find((item) => item.testKey === "accessibility.axe.admin.dashboard");

    assert.equal(outcome.exitCode, 1);
    assert.equal(result.status, "BLOCKED");
    assert.match(result.error, /Authentication/);
  } finally {
    restoreEnv("ADMIN_EMAIL", previousEmail);
    restoreEnv("ADMIN_PASSWORD", previousPassword);
    await fixture.stop();
  }
});

test("S8 unavailable quality adapter is blocked without crashing report generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-a11y-unavailable-"));
  const config = accessibilityConfig({
    root,
    url: "http://localhost:3000",
    projectName: "a11y-unavailable",
    include: ["/"],
    layers: ["accessibility"]
  });
  const orchestrator = new RunOrchestrator(new SqliteRunStore(join(root, "qagent.sqlite")), new FileReporter(), {
    qualityAdapters: [new AxeAccessibilityAdapter({ unavailableReason: "axe missing for test" })]
  });
  const outcome = await orchestrator.run({
    config,
    mode: "cloud",
    cwd: root,
    artifactRoot: join(root, "runs"),
    url: "http://localhost:3000"
  });
  const report = JSON.parse(readFileSync(outcome.reportOutput.jsonPath, "utf8"));

  assert.equal(outcome.exitCode, 1);
  assert.equal(report.results.find((result) => result.testKey === "accessibility.axe-accessibility.available").status, "BLOCKED");
  assert.equal(existsSync(outcome.reportOutput.htmlPath), true);
});

test("S8 accessibility findings participate in baseline regression comparison", async () => {
  const good = await startFixture("tests/fixtures/accessibility-good-server.mjs");
  const bad = await startFixture("tests/fixtures/accessibility-bad-server.mjs");
  try {
    const root = mkdtempSync(join(tmpdir(), "qagent-a11y-regression-"));
    const dbPath = join(root, "qagent.sqlite");
    const goodRun = await runAccessibility(good.url, { root, dbPath, projectName: "a11y-regression", include: ["/"] });
    const badRun = await runAccessibility(bad.url, { root, dbPath, projectName: "a11y-regression", include: ["/"] });

    const cli = resolve("dist/apps/cli/src/index.js");
    const createGood = spawnSync(process.execPath, [cli, "baseline", "create", "--run", goodRun.outcome.runId, "--name", "good", "--db", dbPath], {
      encoding: "utf8"
    });
    assert.equal(createGood.status, 0, createGood.stderr || createGood.stdout);

    const compareNew = spawnSync(process.execPath, [cli, "compare", "--run", badRun.outcome.runId, "--baseline", "good", "--db", dbPath, "--output", join(root, "comparisons-new")], {
      encoding: "utf8"
    });
    assert.equal(compareNew.status, 1, compareNew.stderr || compareNew.stdout);
    assert.match(compareNew.stdout, /newFindings=/);
    assert.doesNotMatch(compareNew.stdout, /newFindings=0/);

    const createBad = spawnSync(process.execPath, [cli, "baseline", "create", "--run", badRun.outcome.runId, "--name", "bad", "--db", dbPath], {
      encoding: "utf8"
    });
    assert.equal(createBad.status, 0, createBad.stderr || createBad.stdout);

    const compareResolved = spawnSync(
      process.execPath,
      [cli, "compare", "--run", goodRun.outcome.runId, "--baseline", "bad", "--db", dbPath, "--output", join(root, "comparisons-resolved")],
      { encoding: "utf8" }
    );
    assert.equal(compareResolved.status, 0, compareResolved.stderr || compareResolved.stdout);
    assert.match(compareResolved.stdout, /resolvedFindings=/);
    assert.doesNotMatch(compareResolved.stdout, /resolvedFindings=0/);

    const [comparisonDir] = readdirSync(join(root, "comparisons-new"));
    const comparison = JSON.parse(readFileSync(join(root, "comparisons-new", comparisonDir, "comparison.json"), "utf8"));
    assert.ok(comparison.summary.newFindings > 0);
    assert.equal(comparison.findingEntries.some((entry) => entry.classification === "new-finding"), true);
  } finally {
    await good.stop();
    await bad.stop();
  }
});

async function runAccessibility(url, options) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "qagent-a11y-"));
  const dbPath = options.dbPath ?? join(root, "qagent.sqlite");
  const config = accessibilityConfig({
    root,
    url,
    projectName: options.projectName,
    include: options.include,
    profiles: options.profiles ?? [],
    layers: ["accessibility"]
  });
  if (options.auth) {
    config.auth.profiles = authProfiles();
  }

  const orchestrator = new RunOrchestrator(new SqliteRunStore(dbPath), new FileReporter(), {
    qualityAdapters: [new AxeAccessibilityAdapter()]
  });
  const outcome = await orchestrator.run({
    config,
    mode: "cloud",
    cwd: root,
    artifactRoot: join(root, "runs"),
    url
  });
  const report = JSON.parse(readFileSync(outcome.reportOutput.jsonPath, "utf8"));
  return { outcome, report };
}

function accessibilityConfig(input) {
  const config = createConfigFromOverrides({
    cwd: input.root,
    urlOverride: input.url
  });
  config.project.name = input.projectName;
  config.discovery.max_pages = 1;
  config.discovery.max_depth = 0;
  config.tests.layers = input.layers;
  config.report.evidence_on = "failure";
  config.accessibility = {
    ...config.accessibility,
    include: input.include,
    profiles: input.profiles ?? [],
    maxPages: 5,
    timeout_seconds: 10,
    maxNodesPerRule: 3
  };
  return config;
}

function authProfiles() {
  return {
    admin: {
      loginUrl: "/login",
      credentials: {
        username: "${ADMIN_EMAIL}",
        password: "${ADMIN_PASSWORD}"
      },
      selectors: {
        username: '[name="email"]',
        password: '[name="password"]',
        submit: "#submit"
      },
      success: {
        urlContains: "/dashboard"
      }
    }
  };
}

async function startFixture(script, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(script)], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`${script} did not become ready`)), 5000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.stderr.on("data", (chunk) => {
      clearTimeout(timeout);
      rejectReady(new Error(String(chunk)));
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`${script} exited before ready: ${code}`));
    });
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    async stop() {
      child.kill();
      await new Promise((resolveStop) => child.once("exit", resolveStop));
    }
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function assertXlsxArchive(path) {
  const data = readFileSync(path);
  assert.equal(data.subarray(0, 2).toString(), "PK");
  assert.equal(data.includes(Buffer.from("xl/workbook.xml")), true);
  assert.match(readZipEntry(data, "xl/workbook.xml"), /Accessibility/);
}

function readZipEntry(data, entryName) {
  const eocdOffset = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocdOffset, -1);
  const centralDirectorySize = data.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = data.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (offset < end) {
    assert.equal(data.readUInt32LE(offset), 0x02014b50);
    const compression = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const fileNameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localHeaderOffset = data.readUInt32LE(offset + 42);
    const fileName = data.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");

    if (fileName === entryName) {
      assert.equal(data.readUInt32LE(localHeaderOffset), 0x04034b50);
      const localNameLength = data.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = data.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const payload = data.subarray(dataStart, dataStart + compressedSize);
      if (compression === 0) {
        return payload.toString("utf8");
      }
      assert.equal(compression, 8);
      return inflateRawSync(payload).toString("utf8");
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error(`Zip entry not found: ${entryName}`);
}

function restoreEnv(name, previous) {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}
