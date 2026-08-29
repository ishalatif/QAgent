import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SafeProcessRunner } from "#process-runner";

describe("SafeProcessRunner", () => {
  it("runs executable plus args without a shell and redacts output", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "qagent-process-"));
    const runner = new SafeProcessRunner({ rootDir, redactValues: ["opaque-secret-value"] });

    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "console.log('token=secret'); console.log('opaque-secret-value')"]
    });

    expect(result.status).toBe("PASS");
    expect(result.stdout).toContain("token=<redacted>");
    expect(result.stdout).toContain("<redacted>");
    expect(result.stdout).not.toContain("opaque-secret-value");
  });

  it("rejects working directories outside the configured root", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "qagent-process-"));
    const runner = new SafeProcessRunner({ rootDir });

    expect(() =>
      runner.run(
        {
          executable: process.execPath,
          args: ["-e", "console.log('nope')"]
        },
        { cwd: resolve(rootDir, "..") }
      )
    ).toThrow(/inside configured root/);
  });

  it("maps timed-out commands to COMMAND_TIMEOUT", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "qagent-process-"));
    const runner = new SafeProcessRunner({ rootDir });

    const result = await runner.run(
      {
        executable: process.execPath,
        args: ["-e", "setTimeout(() => undefined, 1000)"]
      },
      { timeoutMs: 10 }
    );

    expect(result.status).toBe("ERROR");
    expect(result.stderr).toContain("COMMAND_TIMEOUT");
  });
});
