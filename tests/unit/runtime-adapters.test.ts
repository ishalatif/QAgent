import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigFromOverrides } from "#config";
import {
  DuplicateRuntimeAdapterIdError,
  NodeAdapter,
  RuntimeAdapterRegistry,
  RuntimeSourceAdapter,
  detectRuntime,
  defaultRuntimeAdapterRegistry
} from "#runtime-adapters";

const fixtureRoot = resolve(process.cwd(), "tests", "fixtures");

describe("runtime adapter detection", () => {
  it("detects Node projects with deterministic package manager and framework evidence", () => {
    const sourcePath = join(fixtureRoot, "source-node-good");
    const result = detectRuntime(sourcePath);

    expect(result.adapterId).toBe("node");
    expect(result.runtime).toBe("node");
    expect(result.status).toBe("SUPPORTED");
    expect(result.confidence).toBe("high");
    expect(result.packageManager).toBe("npm");
    expect(result.framework).toBe("vite");
    expect(result.markers).toEqual(["package.json", "package-lock.json", "tsconfig.json"]);
  });

  it("prefers pnpm over yarn over npm when multiple Node locks exist", () => {
    const sourcePath = mkdtempSync(join(tmpdir(), "qagent-runtime-node-"));
    writeFileSync(join(sourcePath, "package.json"), JSON.stringify({ scripts: { test: "node -e 1" } }), "utf8");
    writeFileSync(join(sourcePath, "package-lock.json"), "{}", "utf8");
    writeFileSync(join(sourcePath, "yarn.lock"), "", "utf8");
    writeFileSync(join(sourcePath, "pnpm-lock.yaml"), "", "utf8");

    expect(detectRuntime(sourcePath).packageManager).toBe("pnpm");
  });

  it("recognizes planned runtimes without marking them executable", () => {
    const sourcePath = mkdtempSync(join(tmpdir(), "qagent-runtime-php-"));
    writeFileSync(join(sourcePath, "composer.json"), "{}", "utf8");

    const result = detectRuntime(sourcePath);

    expect(result.adapterId).toBe("php");
    expect(result.status).toBe("PLANNED");
    expect(result.reason).toMatch(/not executable in S5/);
  });

  it("keeps unknown folders unsupported unless explicit generic commands are configured", () => {
    const sourcePath = join(fixtureRoot, "source-unknown");
    expect(detectRuntime(sourcePath).status).toBe("UNSUPPORTED");

    const config = createConfigFromOverrides({ cwd: process.cwd(), sourcePath });
    config.source = {
      adapter: "generic",
      commands: {
        test: { executable: "node", args: ["-e", "console.log('ok')"] }
      }
    };

    const result = detectRuntime(sourcePath, config);
    expect(result.adapterId).toBe("generic");
    expect(result.status).toBe("LIMITED");
    expect(result.confidence).toBe("high");
  });

  it("does not crash on malformed package.json", async () => {
    const sourcePath = mkdtempSync(join(tmpdir(), "qagent-runtime-malformed-"));
    writeFileSync(join(sourcePath, "package.json"), "{", "utf8");
    const config = createConfigFromOverrides({ cwd: process.cwd(), sourcePath });
    config.safety.allow_source_commands = true;

    const output = await new RuntimeSourceAdapter().runSource({
      runId: "run_test",
      sourcePath,
      config,
      artifactDir: join(sourcePath, ".qagent"),
      inspectOnly: false
    });

    expect(output.sourceProject?.runtime).toBe("node");
    expect(output.results.find((result) => result.testKey === "source.inspect")?.status).toBe("BLOCKED");
    expect(JSON.stringify(output)).toContain("MALFORMED_PACKAGE_JSON");
  });
});

describe("runtime adapter registry", () => {
  it("returns deterministic summaries and rejects duplicate IDs", () => {
    const registry = defaultRuntimeAdapterRegistry();

    expect(registry.summaries().map((adapter) => adapter.id)).toEqual(["node", "python", "generic", "php", "java", "dotnet", "go"]);
    expect(() => registry.register(new NodeAdapter())).toThrow(DuplicateRuntimeAdapterIdError);
  });

  it("reports Node package scripts as capabilities and honors inspect-only", () => {
    const sourcePath = join(fixtureRoot, "source-node-good");
    const config = createConfigFromOverrides({ cwd: process.cwd(), sourcePath });
    config.safety.allow_source_commands = true;
    const detection = detectRuntime(sourcePath, config);

    const runnable = new NodeAdapter().inspect({ sourcePath, config, detection, inspectOnly: false });
    expect(runnable.commandPlan.map((command) => command.capability)).toEqual(["lint", "typeCheck", "test", "build"]);
    expect(runnable.sourceProject.capabilities.find((capability) => capability.name === "test")?.state).toBe("SUPPORTED");

    const inspectOnly = new NodeAdapter().inspect({ sourcePath, config, detection, inspectOnly: true });
    expect(inspectOnly.commandPlan).toEqual([]);
    expect(inspectOnly.sourceProject.capabilities.find((capability) => capability.name === "test")?.state).toBe("DISABLED");
  });
});
