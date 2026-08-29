import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createConfigFromOverrides } from "#config";
import { RunOrchestrator } from "#core";
import { HttpApiTestAdapter } from "#api-testing";
import { FileReporter } from "#reporting";
import { SqliteRunStore } from "#storage";

test("API/RBAC adapter detects intentional authorization bypass", async () => {
  const fixture = await startApiFixture();
  try {
    const { outcome, report } = await runApiRbac(fixture.url, apiRbacConfig);
    const health = report.results.find((result) => result.testKey === "api.health");
    const admin = report.results.find((result) => result.testKey === "authorization.create-course.admin.allow");
    const learner = report.results.find((result) => result.testKey === "authorization.create-course.learner.deny");

    assert.equal(outcome.exitCode, 1);
    assert.equal(health.status, "PASS");
    assert.equal(admin.status, "PASS");
    assert.equal(learner.status, "FAIL");
    assert.equal(report.findings.some((finding) => finding.category === "authorization-bypass" && finding.severity === "High"), true);
    assert.equal(report.evidence.some((item) => item.relativePath.includes("authorization.create-course.learner.deny")), true);
    assert.equal(existsSync(outcome.reportOutput.htmlPath), true);
    assert.equal(existsSync(outcome.reportOutput.junitPath), true);
  } finally {
    await fixture.stop();
  }
});

test("API adapter redacts environment-backed Authorization headers from report evidence", async () => {
  const fixture = await startApiFixture();
  const previousToken = process.env.QAGENT_ADMIN_TOKEN;
  const token = "s6-secret-token";
  process.env.QAGENT_ADMIN_TOKEN = token;
  try {
    const { outcome, report } = await runApiRbac(fixture.url, (config) => {
      config.tests.layers = ["api"];
      config.report.evidence_on = "always";
      config.auth.profiles = {
        admin: authProfile("admin", {
          authorization: "Bearer ${QAGENT_ADMIN_TOKEN}"
        })
      };
      config.api.assertions = [
        {
          key: "health-authenticated",
          method: "GET",
          path: "/api/health",
          profile: "admin",
          expected_status: 200
        }
      ];
      config.api.authorization = [];
    });
    const evidencePath = join(outcome.reportOutput.rootDir, report.results.find((result) => result.testKey === "api.health-authenticated").evidenceRefs[0].relativePath);

    assert.equal(outcome.exitCode, 0);
    assert.equal(JSON.stringify(report).includes(token), false);
    assert.equal(readFileSync(evidencePath, "utf8").includes(token), false);
  } finally {
    if (previousToken === undefined) {
      delete process.env.QAGENT_ADMIN_TOKEN;
    } else {
      process.env.QAGENT_ADMIN_TOKEN = previousToken;
    }
    await fixture.stop();
  }
});

test("API adapter blocks sensitive literal headers before contacting the target", async () => {
  const fixture = await startApiFixture();
  try {
    const { outcome, report } = await runApiRbac(fixture.url, (config) => {
      config.tests.layers = ["api"];
      config.api.assertions = [
        {
          key: "literal-auth-header",
          method: "GET",
          path: "/api/health",
          headers: {
            authorization: "Bearer literal-secret"
          },
          expected_status: 200
        }
      ];
    });
    const result = report.results.find((item) => item.testKey === "api.literal-auth-header");

    assert.equal(outcome.exitCode, 1);
    assert.equal(result.status, "BLOCKED");
    assert.match(result.error, /must reference an environment variable/);
  } finally {
    await fixture.stop();
  }
});

async function runApiRbac(url, configure) {
  const root = mkdtempSync(join(tmpdir(), "qagent-api-rbac-"));
  const config = createConfigFromOverrides({ cwd: root, urlOverride: url });
  config.discovery.max_pages = 1;
  config.tests.layers = ["api", "authorization"];
  config.report.evidence_on = "failure";
  config.api.assertions = [];
  config.api.authorization = [];
  configure(config);

  const store = new SqliteRunStore(join(root, "qagent.sqlite"));
  const reporter = new FileReporter();
  const orchestrator = new RunOrchestrator(store, reporter, {
    apiTestAdapter: new HttpApiTestAdapter()
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

function apiRbacConfig(config) {
  config.auth.profiles = {
    admin: authProfile("admin", { "x-qagent-role": "admin" }),
    learner: authProfile("learner", { "x-qagent-role": "learner" })
  };
  config.permissions = {
    create_course: {
      allow: ["admin"],
      deny: ["learner"]
    }
  };
  config.api.assertions = [
    {
      key: "health",
      method: "GET",
      path: "/api/health",
      expected_status: 200
    }
  ];
  config.api.authorization = [
    {
      key: "create-course",
      permission: "create_course",
      method: "POST",
      path: "/api/courses",
      body: {
        title: "QAgent S6"
      },
      allow_status: [200, 201],
      deny_status: 403
    }
  ];
}

function authProfile(name, headers) {
  return {
    loginUrl: "/login",
    credentials: {
      username: `\${${name.toUpperCase()}_EMAIL}`,
      password: `\${${name.toUpperCase()}_PASSWORD}`
    },
    selectors: {
      username: '[name="email"]',
      password: '[name="password"]',
      submit: 'button[type="submit"]'
    },
    success: {
      urlContains: "/dashboard"
    },
    api: {
      headers
    }
  };
}

async function startApiFixture() {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve("tests/fixtures/api-rbac-server.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("api fixture did not become ready")), 5_000);
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
      rejectReady(new Error(`api fixture exited before ready: ${code}`));
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
