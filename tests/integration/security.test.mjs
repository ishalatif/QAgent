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
import { PassiveSecurityAdapter } from "#quality-adapters";

test("passive security adapter passes pages with configured headers and cookie flags", async () => {
  const fixture = await startFixture("tests/fixtures/security-server.mjs");
  try {
    const { outcome, report } = await runSecurity(fixture.url, {
      projectName: "security-pass",
      include: ["/secure"]
    });

    assert.equal(outcome.exitCode, 0);
    assert.equal(report.results.find((result) => result.testKey === "security.passive-http.public.secure").status, "PASS");
    assert.equal(report.findings.filter((finding) => finding.category === "security").length, 0);
    assert.equal(existsSync(outcome.reportOutput.htmlPath), true);
    assert.match(readFileSync(outcome.reportOutput.htmlPath, "utf8"), /Security Summary/);
    assertXlsxArchive(outcome.reportOutput.xlsxPath, /Security/);
  } finally {
    await fixture.stop();
  }
});

test("passive security adapter fails missing headers and weak cookies with bounded evidence", async () => {
  const fixture = await startFixture("tests/fixtures/security-server.mjs");
  try {
    const { outcome, report } = await runSecurity(fixture.url, {
      projectName: "security-fail",
      include: ["/weak"]
    });
    const findings = report.findings.filter((finding) => finding.category === "security");

    assert.equal(outcome.exitCode, 1);
    assert.equal(report.results.find((result) => result.testKey === "security.passive-http.public.weak").status, "FAIL");
    assert.ok(findings.length >= 4);
    assert.equal(findings.every((finding) => finding.details?.check), true);
    assert.equal(report.evidence.some((item) => item.relativePath === "evidence/security/passive-findings.json"), true);
    assert.equal(readFileSync(join(outcome.reportOutput.rootDir, "evidence/security/passive-findings.json"), "utf8").includes("qagent_weak=1"), false);
  } finally {
    await fixture.stop();
  }
});

test("passive security adapter blocks cleanly when unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "qagent-security-unavailable-"));
  const config = securityConfig({
    root,
    url: "http://localhost:3000",
    projectName: "security-unavailable",
    include: ["/"]
  });
  const orchestrator = new RunOrchestrator(new SqliteRunStore(join(root, "qagent.sqlite")), new FileReporter(), {
    qualityAdapters: [new PassiveSecurityAdapter({ unavailableReason: "security adapter disabled for test" })]
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
  assert.equal(report.results.find((result) => result.testKey === "security.passive-security.available").status, "BLOCKED");
  assert.equal(existsSync(outcome.reportOutput.htmlPath), true);
});

async function runSecurity(url, options) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "qagent-security-"));
  const config = securityConfig({
    root,
    url,
    projectName: options.projectName,
    include: options.include
  });

  const orchestrator = new RunOrchestrator(new SqliteRunStore(join(root, "qagent.sqlite")), new FileReporter(), {
    qualityAdapters: [new PassiveSecurityAdapter()]
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

function securityConfig(input) {
  const config = createConfigFromOverrides({
    cwd: input.root,
    urlOverride: input.url
  });
  config.project.name = input.projectName;
  config.discovery.max_pages = 1;
  config.discovery.max_depth = 0;
  config.tests.layers = ["security"];
  config.report.evidence_on = "failure";
  config.security = {
    ...config.security,
    include: input.include,
    maxPages: 5,
    timeout_seconds: 10
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
