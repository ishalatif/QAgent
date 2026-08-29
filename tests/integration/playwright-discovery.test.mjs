import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfigFromOverrides } from "#config";
import { PlaywrightCloudDiscoveryAdapter } from "#browser-playwright";

test("Playwright Cloud Mode discovery crawls pages and observes browser traffic", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
        <title>Fixture Home</title>
        <a href="/about?token=secret#details">About</a>
        <form><input name="email"></form>
        <script>
          console.error("fixture console problem token=secret");
          fetch("/api/data?token=secret").catch(() => {});
        </script>`);
      return;
    }

    if (request.url?.startsWith("/about")) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>About</title><a href='/logout'>Logout</a>");
      return;
    }

    if (request.url?.startsWith("/api/data")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("missing");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const url = `http://127.0.0.1:${address.port}/`;
    const config = createConfigFromOverrides({
      cwd: process.cwd(),
      urlOverride: url
    });
    config.discovery.max_pages = 5;
    config.discovery.exclude = ["/logout"];
    config.target.allowed_hosts = ["127.0.0.1"];

    const adapter = new PlaywrightCloudDiscoveryAdapter({ navigationTimeoutMs: 5000, settleTimeoutMs: 500 });
    const output = await adapter.discover({
      runId: "run_20260827220000_testabcd",
      url,
      config,
      artifactDir: mkdtempSync(join(tmpdir(), "qagent-playwright-"))
    });

    assert.equal(output.pages.length, 2);
    assert.ok(output.pages.some((page) => page.normalizedUrl.endsWith("/about")));
    assert.ok(output.apiEndpoints.some((endpoint) => endpoint.normalizedPath === "/api/data"));
    assert.ok(output.findings.some((finding) => finding.category === "browser-console"));
    assert.equal(output.findings.some((finding) => finding.description.includes("secret")), false);
    assert.equal(output.results.find((result) => result.testKey === "cloud.discovery.crawl")?.status, "FAIL");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Playwright Cloud Mode discovery enforces duplicate prevention, max pages, and depth", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
        <title>Root</title>
        <a href="/a?x=1#top">A1</a>
        <a href="/a?x=2#bottom">A2 duplicate by normalized URL</a>
        <a href="/b">B</a>
        <a href="https://example.com/external">External</a>`);
      return;
    }

    if (request.url?.startsWith("/a")) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>A</title><a href='/deep'>Deep</a>");
      return;
    }

    if (request.url === "/b") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>B</title>");
      return;
    }

    response.writeHead(204);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const url = `http://127.0.0.1:${address.port}/`;
    const config = createConfigFromOverrides({ cwd: process.cwd(), urlOverride: url });
    config.discovery.max_pages = 2;
    config.discovery.max_depth = 1;
    config.target.allowed_hosts = ["127.0.0.1"];

    const output = await new PlaywrightCloudDiscoveryAdapter({ navigationTimeoutMs: 5000, settleTimeoutMs: 250 }).discover({
      runId: "run_20260827220100_limitab",
      url,
      config,
      artifactDir: mkdtempSync(join(tmpdir(), "qagent-playwright-"))
    });

    assert.equal(output.pages.length, 2);
    assert.equal(output.pages.filter((page) => page.normalizedUrl.includes("/a")).length, 1);
    assert.equal(output.pages.some((page) => page.normalizedUrl.includes("/deep")), false);
    assert.equal(output.pages.some((page) => page.normalizedUrl.includes("example.com")), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Playwright Cloud Mode discovery records valid redirects without failing", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(302, { location: "/final" });
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Final</title>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const url = `http://127.0.0.1:${address.port}/`;
    const config = createConfigFromOverrides({ cwd: process.cwd(), urlOverride: url });
    config.target.allowed_hosts = ["127.0.0.1"];

    const output = await new PlaywrightCloudDiscoveryAdapter({ navigationTimeoutMs: 5000, settleTimeoutMs: 250 }).discover({
      runId: "run_20260827220200_redirab",
      url,
      config,
      artifactDir: mkdtempSync(join(tmpdir(), "qagent-playwright-"))
    });

    assert.equal(output.findings.length, 0);
    assert.equal(output.pages[0].redirectCount, 1);
    assert.ok(output.pages[0].finalUrl?.endsWith("/final"));
    assert.equal(output.results.find((result) => result.testKey === "cloud.discovery.crawl")?.status, "PASS");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Playwright Cloud Mode discovery times out deterministically and saves screenshot evidence", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Slow</title>");
      }, 2000);
      return;
    }

    response.writeHead(204);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const url = `http://127.0.0.1:${address.port}/`;
    const config = createConfigFromOverrides({ cwd: process.cwd(), urlOverride: url });
    config.target.allowed_hosts = ["127.0.0.1"];

    const output = await new PlaywrightCloudDiscoveryAdapter({ navigationTimeoutMs: 250, settleTimeoutMs: 100 }).discover({
      runId: "run_20260827220300_timeout",
      url,
      config,
      artifactDir: mkdtempSync(join(tmpdir(), "qagent-playwright-"))
    });

    assert.ok(output.findings.some((finding) => finding.category === "navigation-timeout"));
    assert.ok(output.evidence.some((evidence) => evidence.type === "screenshot"));
    assert.ok(output.evidence.some((evidence) => evidence.type === "trace" && evidence.relativePath.includes("cloud.discovery.trace.zip")));
    assert.equal(output.results.find((result) => result.testKey === "cloud.discovery.crawl")?.status, "FAIL");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
