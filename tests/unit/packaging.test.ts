import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package release manifest", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    bin: Record<string, string>;
    files: string[];
    imports: Record<string, string>;
    scripts: Record<string, string>;
  };

  it("ships compiled CLI/dashboard output instead of relying on gitignore fallback", () => {
    expect(manifest.bin.qagent).toBe("dist/apps/cli/src/index.js");
    expect(manifest.files).toContain("dist");
    expect(manifest.files).toContain("docs/schemas");
    expect(manifest.files).toContain("examples");
    expect(manifest.files).not.toContain("tests");
    expect(manifest.files).not.toContain(".qagent");
  });

  it("keeps release, security, and compatibility checks scriptable", () => {
    expect(manifest.scripts["release:check"]).toContain("npm pack --dry-run");
    expect(manifest.scripts["test:security"]).toContain("safety.test.ts");
    expect(manifest.scripts["test:compatibility"]).toContain("runtime-adapters.test.ts");
    expect(manifest.imports["#dashboard"]).toBe("./dist/packages/dashboard/src/index.js");
  });
});
