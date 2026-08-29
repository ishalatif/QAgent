import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { createConfigFromOverrides } from "#config";
import { RunOrchestrator } from "#core";
import { FileReporter } from "#reporting";
import { SqliteRunStore } from "#storage";
import { HttpLoadSmokeAdapter } from "#quality-adapters";

test("HTTP load smoke adapter passes bounded local opt-in checks", async () => {
  const fixture = await startFixture("tests/fixtures/load-server.mjs");
  try {
    const { outcome, report } = await runLoad(fixture.url, {
      projectName: "load-pass",
      include: ["/ok"],
      loadTest: true
    });

    assert.equal(outcome.exitCode, 0);
    assert.equal(report.results.find((result) => result.testKey === "load.http-smoke.public.ok").status, "PASS");
    assert.equal(report.findings.filter((finding) => finding.category === "load").length, 0);
    assert.equal(existsSync(outcome.reportOutput.htmlPath), true);
    assert.match(readFileSync(outcome.reportOutput.htmlPath, "utf8"), /Load Summary/);
    assertXlsxArchive(outcome.reportOutput.xlsxPath, /Load/);
  } finally {
    await fixture.stop();
  }
});

test("HTTP load smoke adapter fails server errors and writes bounded evidence", async () => {
  const fixture = await startFixture("tests/fixtures/load-server.mjs");
  try {
    const { outcome, report } = await runLoad(fixture.url, {
      projectName: "load-fail",
      include: ["/error"],
      loadTest: true
    });
    const findings = report.findings.filter((finding) => finding.category === "load");

    assert.equal(outcome.exitCode, 1);
    assert.equal(report.results.find((result) => result.testKey === "load.http-smoke.public.error").status, "FAIL");
    assert.ok(findings.length > 0);
    assert.equal(findings.some((finding) => finding.details?.metric === "maxErrorRate"), true);
    assert.equal(report.evidence.some((item) => item.relativePath === "evidence/load/summary.json"), true);
    assert.equal(readFileSync(join(outcome.reportOutput.rootDir, "evidence/load/summary.json"), "utf8").length < 30000, true);
  } finally {
    await fixture.stop();
  }
});

test("HTTP load smoke adapter blocks before contacting target without safety opt-in", async () => {
  const fixture = await startFixture("tests/fixtures/load-server.mjs");
  try {
    const { outcome, report } = await runLoad(fixture.url, {
      projectName: "load-blocked",
      include: ["/ok"],
      loadTest: false
    });

    assert.equal(outcome.exitCode, 1);
    assert.equal(report.results.find((result) => result.testKey === "load.http-smoke.safety").status, "BLOCKED");
    assert.equal(report.results.some((result) => result.testKey === "load.http-smoke.public.ok"), false);
  } finally {
    await fixture.stop();
  }
});

async function runLoad(url, options) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "qagent-load-"));
  const config = loadConfig({
    root,
    url,
    projectName: options.projectName,
    include: options.include,
    loadTest: options.loadTest
  });

  const orchestrator = new RunOrchestrator(new SqliteRunStore(join(root, "qagent.sqlite")), new FileReporter(), {
    qualityAdapters: [new HttpLoadSmokeAdapter()]
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

function loadConfig(input) {
  const config = createConfigFromOverrides({
    cwd: input.root,
    urlOverride: input.url
  });
  config.project.name = input.projectName;
  config.safety.load_test = input.loadTest;
  config.safety.max_concurrency = 2;
  config.discovery.max_pages = 1;
  config.discovery.max_depth = 0;
  config.tests.layers = ["load"];
  config.report.evidence_on = "failure";
  config.load = {
    ...config.load,
    include: input.include,
    maxPages: 2,
    requestsPerTarget: 3,
    concurrency: 2,
    timeout_seconds: 5,
    thresholds: {
      ...config.load.thresholds,
      maxErrorRate: 0,
      maxAverageMs: 1000,
      maxP95Ms: 2000
    }
  };
  return config;
}

async function startFixture(script) {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(script)], {
    env: { ...process.env, PORT: String(port) },
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

function assertXlsxArchive(path, pattern) {
  const data = readFileSync(path);
  assert.equal(data.subarray(0, 2).toString(), "PK");
  assert.match(readZipEntry(data, "xl/workbook.xml"), pattern);
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
