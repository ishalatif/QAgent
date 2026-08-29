import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type { SourceCommandConfig, StepResult } from "#contracts";
import { redactText } from "#core";

export interface SafeProcessRunnerOptions {
  rootDir: string;
  redactKeys?: string[];
  redactValues?: string[];
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
}

export class SafeProcessRunner {
  constructor(private readonly options: SafeProcessRunnerOptions) {}

  run(command: SourceCommandConfig, options: RunCommandOptions = {}): Promise<StepResult> {
    const startedAt = new Date().toISOString();
    const cwd = resolve(options.cwd ?? this.options.rootDir);
    assertWithinRoot(this.options.rootDir, cwd);
    assertExecutable(command.executable);

    const timeoutMs = options.timeoutMs ?? (command.timeout_seconds ?? 60) * 1000;
    const args = command.args ?? [];

    return new Promise((resolveResult) => {
      const child = spawn(command.executable, args, {
        cwd,
        shell: false,
        windowsHide: true
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        const completedAt = new Date().toISOString();
        resolveResult({
          name: command.executable,
          status: timedOut ? "ERROR" : exitCode === 0 ? "PASS" : "FAIL",
          startedAt,
          durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
          exitCode: exitCode ?? undefined,
          stdout: redactOutput(stdout, this.options),
          stderr: timedOut ? redactOutput(`${stderr}\nCOMMAND_TIMEOUT after ${timeoutMs}ms`, this.options) : redactOutput(stderr, this.options)
        });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        const completedAt = new Date().toISOString();
        resolveResult({
          name: command.executable,
          status: "ERROR",
          startedAt,
          durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
          stderr: redactOutput(error.message, this.options)
        });
      });
    });
  }
}

function redactOutput(input: string, options: SafeProcessRunnerOptions): string {
  let output = redactText(input, options.redactKeys);
  for (const secret of options.redactValues ?? []) {
    if (secret.length >= 3) {
      output = output.split(secret).join("<redacted>");
    }
  }
  return output;
}

function assertWithinRoot(rootDir: string, cwd: string): void {
  const root = resolve(rootDir);
  const rel = relative(root, cwd);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..\\`) || rel.includes("../")) {
    throw new Error(`Command cwd must remain inside configured root: ${cwd}`);
  }
}

function assertExecutable(executable: string): void {
  if (!executable.trim()) {
    throw new Error("Command executable is required.");
  }

  if (/[|&;<>()`]/.test(executable)) {
    throw new Error("Command executable must be a single executable path, not a shell expression.");
  }
}
