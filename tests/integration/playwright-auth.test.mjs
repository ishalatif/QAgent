import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createConfigFromOverrides } from "#config";
import { PlaywrightBrowserTestAdapter } from "#browser-playwright";

test("Playwright browser tests execute deterministic auth profile scenarios", async () => {
  const fixture = await startAuthFixture();
  const previousEmail = process.env.ADMIN_EMAIL;
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_EMAIL = "admin@test.local";
  process.env.ADMIN_PASSWORD = "Password123!";

  try {
    const root = mkdtempSync(join(tmpdir(), "qagent-auth-"));
    const output = await new PlaywrightBrowserTestAdapter().runTests({
      runId: "run_20260828090000_authok",
      url: fixture.url,
      config: authConfig(root, fixture.url),
      artifactDir: join(root, "runs", "run_20260828090000_authok"),
      sessionRoot: join(root, "sessions")
    });

    const statuses = Object.fromEntries(output.results.map((result) => [result.testKey, result.status]));
    assert.deepEqual(statuses, {
      "auth.invalid-login": "PASS",
      "auth.protected-route": "PASS",
      "auth.valid-login": "PASS",
      "auth.logout": "PASS",
      "navigation.dashboard": "PASS"
    });
    assert.equal(output.registeredTests.map((item) => item.key).join(","), "auth.invalid-login,auth.protected-route,auth.valid-login,auth.logout,navigation.dashboard");
    assert.equal(output.authProfiles[0].usernameRef, "${ADMIN_EMAIL}");
    assert.equal(JSON.stringify(output).includes("Password123!"), false);
    assert.equal(JSON.stringify(output).includes("admin@test.local"), false);
    assert.equal(sessionFiles(join(root, "sessions")).some((file) => file.endsWith("admin.storageState.json")), true);
  } finally {
    restoreEnv("ADMIN_EMAIL", previousEmail);
    restoreEnv("ADMIN_PASSWORD", previousPassword);
    await fixture.stop();
  }
});

test("auth failure captures evidence and blocks dependent browser tests", async () => {
  const fixture = await startAuthFixture();
  const previousEmail = process.env.ADMIN_EMAIL;
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_EMAIL = "admin@test.local";
  process.env.ADMIN_PASSWORD = "WrongPassword";

  try {
    const root = mkdtempSync(join(tmpdir(), "qagent-auth-fail-"));
    const output = await new PlaywrightBrowserTestAdapter().runTests({
      runId: "run_20260828090100_authfail",
      url: fixture.url,
      config: authConfig(root, fixture.url),
      artifactDir: join(root, "runs", "run_20260828090100_authfail"),
      sessionRoot: join(root, "sessions")
    });

    const statuses = Object.fromEntries(output.results.map((result) => [result.testKey, result.status]));
    assert.equal(statuses["auth.valid-login"], "FAIL");
    assert.equal(statuses["auth.invalid-login"], "PASS");
    assert.equal(statuses["auth.protected-route"], "PASS");
    assert.equal(statuses["auth.logout"], "BLOCKED");
    assert.equal(statuses["navigation.dashboard"], "BLOCKED");
    assert.ok(output.results.find((result) => result.testKey === "navigation.dashboard")?.actual.blockedBy === "auth.valid-login");
    assert.ok(output.evidence.some((item) => item.type === "screenshot" && item.relativePath.includes("auth.admin.login")));
    assert.ok(output.evidence.some((item) => item.type === "trace" && item.relativePath.includes("auth.admin.login")));
    assert.equal(JSON.stringify(output).includes("WrongPassword"), false);
  } finally {
    restoreEnv("ADMIN_EMAIL", previousEmail);
    restoreEnv("ADMIN_PASSWORD", previousPassword);
    await fixture.stop();
  }
});

async function startAuthFixture() {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve("tests/fixtures/cloud-auth-server.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("auth fixture did not become ready")), 5_000);
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
      rejectReady(new Error(`auth fixture exited before ready: ${code}`));
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

function authConfig(root, url) {
  const config = createConfigFromOverrides({ cwd: root, urlOverride: url });
  config.discovery.max_pages = 5;
  config.discovery.exclude = ["/logout"];
  config.auth.profiles = {
    admin: {
      loginUrl: "/login",
      credentials: {
        username: "${ADMIN_EMAIL}",
        password: "${ADMIN_PASSWORD}"
      },
      selectors: {
        username: '[name="email"]',
        password: '[name="password"]',
        submit: 'button[type="submit"]'
      },
      success: {
        urlContains: "/dashboard"
      }
    }
  };
  return config;
}

function sessionFiles(root) {
  return existsSync(root) ? readdirSync(root, { recursive: true }).map(String) : [];
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
