#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { ConfigValidationError, loadQAgentConfig, starterConfigYaml } from "#config";
import { EXIT_CODES, TEST_LAYERS, type TargetMode, type TestLayer } from "#contracts";
import { RunOrchestrator, SafetyPolicyError } from "#core";
import { startDashboardServer, type DashboardRunTriggerRequest, type DashboardRunTriggerResult } from "#dashboard";
import { FileReporter } from "#reporting";
import { createRegressionComparison, RegressionComparisonError } from "#regression";
import { RegressionStorageError, SqliteRunStore } from "#storage";
import { RuntimeSourceAdapter, defaultRuntimeAdapterRegistry, detectRuntime } from "#runtime-adapters";
import { defaultQualityAdapterRegistry } from "#quality-adapters";
import { HttpApiTestAdapter } from "#api-testing";
import { PlaywrightBrowserTestAdapter, PlaywrightCloudDiscoveryAdapter } from "#browser-playwright";

const require = createRequire(import.meta.url);
const program = new Command();

program.name("qagent").description("QAgent automated web QA runner").version("0.1.0");

program
  .command("init")
  .description("Create a safe starter qa.config.yaml")
  .option("-c, --config <path>", "config file path", "qa.config.yaml")
  .option("--force", "overwrite an existing config file", false)
  .action((options: { config: string; force: boolean }) => {
    const configPath = resolve(process.cwd(), options.config);
    if (existsSync(configPath) && !options.force) {
      console.error(`Config already exists: ${configPath}`);
      process.exitCode = EXIT_CODES.configurationError;
      return;
    }

    writeFileSync(configPath, starterConfigYaml(), "utf8");
    console.log(`Created ${configPath}`);
  });

program
  .command("doctor")
  .description("Validate local QAgent runtime requirements")
  .action(() => {
    const checks = [
      { name: "node", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: process.versions.node },
      { name: "node:sqlite", ok: hasNodeSqlite(), detail: hasNodeSqlite() ? "available" : "missing" },
      { name: "playwright", ok: hasPlaywright(), detail: playwrightDetail() },
      { name: "api-http", ok: true, detail: "available" },
      { name: "axe-accessibility", ok: hasAxeAccessibility(), detail: axeAccessibilityDetail() },
      { name: "browser-performance", ok: hasBrowserPerformance(), detail: browserPerformanceDetail() },
      { name: "passive-security", ok: hasPassiveSecurity(), detail: passiveSecurityDetail() },
      { name: "http-load-smoke", ok: hasHttpLoadSmoke(), detail: httpLoadSmokeDetail() },
      { name: "zap/k6/lighthouse", ok: false, detail: "optional external adapters planned" }
    ];

    for (const check of checks) {
      console.log(`${check.ok ? "PASS" : "INFO"} ${check.name}: ${check.detail}`);
    }
  });

program
  .command("dashboard")
  .description("Start the local dashboard beta")
  .option("--db <path>", "SQLite DB path", ".qagent/qagent.sqlite")
  .option("--host <host>", "HTTP bind host", "127.0.0.1")
  .option("--port <port>", "HTTP port", "4810")
  .option("-c, --config <path>", "default qa.config.yaml path for run triggers")
  .option("--output <path>", "artifact output root for run triggers", ".qagent/runs")
  .option("--allow-run-trigger", "enable POST /api/v1/runs trigger workflow", false)
  .option("--json", "print machine-readable server output", false)
  .action(async (options: DashboardOptions) => {
    try {
      const cwd = process.cwd();
      const dbPath = resolve(cwd, options.db);
      const artifactRoot = resolve(cwd, options.output);
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new ConfigValidationError("Invalid dashboard port.", ["--port must be an integer between 0 and 65535"]);
      }

      const server = await startDashboardServer({
        dbPath,
        host: options.host,
        port,
        runTrigger: options.allowRunTrigger
          ? {
              enabled: true,
              trigger: (request) =>
                runDashboardTriggeredRun(request, {
                  cwd,
                  dbPath,
                  artifactRoot,
                  defaultConfigPath: options.config
                })
            }
          : undefined
      });

      if (options.json) {
        console.log(JSON.stringify({ url: server.url, dbPath, host: server.host, port: server.port, runTrigger: options.allowRunTrigger }));
      } else {
        console.log(`QAgent dashboard: ${server.url}`);
        console.log(`Database: ${dbPath}`);
        console.log(`Run trigger: ${options.allowRunTrigger ? "enabled" : "disabled"}`);
        console.log("Press Ctrl+C to stop.");
      }

      const shutdown = async (): Promise<void> => {
        await server.close();
        process.exit(0);
      };
      process.once("SIGINT", () => {
        void shutdown();
      });
      process.once("SIGTERM", () => {
        void shutdown();
      });
    } catch (error) {
      handleCliError(error, options.json);
    }
  });

program
  .command("run")
  .description("Run QAgent against a URL or source folder")
  .argument("[folder]", "source folder for Source Mode")
  .option("--url <url>", "target URL for Cloud Mode")
  .option("-c, --config <path>", "qa.config.yaml path")
  .option("--profile <name>", "auth profile name")
  .option("--test <keys>", "comma-separated browser test keys")
  .option("--tag <tags>", "comma-separated browser test tags")
  .option("--layers <layers>", "comma-separated test layers")
  .option("--inspect-only", "inspect Source Mode metadata without executing source commands", false)
  .option("--allow-source-commands", "allow safe Source Mode lint/typecheck/test/build commands", false)
  .option("--db <path>", "SQLite DB path", ".qagent/qagent.sqlite")
  .option("--output <path>", "artifact output root", ".qagent/runs")
  .option("--json", "print machine-readable final output", false)
  .action(async (folder: string | undefined, options: RunOptions) => {
    try {
      if (options.url && folder) {
        throw new ConfigValidationError("Choose either --url for Cloud Mode or a folder for Source Mode, not both.");
      }

      const cwd = process.cwd();
      const mode: TargetMode = options.url ? "cloud" : "source";
      const sourcePath = mode === "source" ? folder ?? "." : undefined;
      const config = loadQAgentConfig({
        cwd,
        configPath: options.config,
        urlOverride: options.url,
        sourcePath,
        profile: options.profile,
        layers: parseLayers(options.layers),
        allowSourceCommands: options.allowSourceCommands
      });

      const dbPath = resolve(cwd, options.db);
      const artifactRoot = resolve(cwd, options.output);
      mkdirSync(artifactRoot, { recursive: true });

      if (!options.json) {
        console.log(`QAgent run starting (${mode})`);
        console.log(`Project: ${config.project.name}`);
        console.log(`Target: ${options.url ?? sourcePath ?? config.target.url ?? "."}`);
      }

      const store = new SqliteRunStore(dbPath);
      const reporter = new FileReporter();
      const qualityRegistry = defaultQualityAdapterRegistry();
      const orchestrator = new RunOrchestrator(store, reporter, {
        cloudDiscoveryAdapter: mode === "cloud" ? new PlaywrightCloudDiscoveryAdapter() : undefined,
        browserTestAdapter: mode === "cloud" ? new PlaywrightBrowserTestAdapter() : undefined,
        apiTestAdapter: mode === "cloud" ? new HttpApiTestAdapter() : undefined,
        sourceModeAdapter: mode === "source" ? new RuntimeSourceAdapter() : undefined,
        qualityAdapters: mode === "cloud" ? qualityRegistry.list() : undefined
      });
      const outcome = await orchestrator.run({
        config,
        mode,
        cwd,
        artifactRoot,
        configPath: options.config ? resolve(cwd, options.config) : undefined,
        url: options.url,
        sourcePath,
        profile: options.profile,
        testKeys: parseCsv(options.test),
        tags: parseCsv(options.tag),
        inspectOnly: options.inspectOnly || !config.safety.allow_source_commands
      });

      if (options.json) {
        console.log(JSON.stringify(outcome));
      } else {
        printOutcome(outcome);
      }
      process.exitCode = outcome.exitCode;
    } catch (error) {
      handleCliError(error, options.json);
    }
  });

program
  .command("tests")
  .description("List registered browser tests")
  .option("--test <keys>", "comma-separated browser test keys")
  .option("--tag <tags>", "comma-separated browser test tags")
  .option("--profile <name>", "browser profile filter")
  .option("--json", "print machine-readable registry output", false)
  .action((options: TestsOptions) => {
    const adapter = new PlaywrightBrowserTestAdapter();
    const keys = new Set(parseCsv(options.test) ?? []);
    const tags = new Set(parseCsv(options.tag) ?? []);
    const tests = adapter.listTests().filter((test) => {
      if (keys.size > 0 && !keys.has(test.key)) {
        return false;
      }
      if (tags.size > 0 && !test.tags.some((tag) => tags.has(tag))) {
        return false;
      }
      if (options.profile && test.profile !== options.profile) {
        return false;
      }
      return true;
    });

    if (options.json) {
      console.log(JSON.stringify(tests, null, 2));
      return;
    }

    for (const test of tests) {
      const profile = test.profile ? ` profile=${test.profile}` : "";
      const tagsText = test.tags.length ? ` tags=${test.tags.join(",")}` : "";
      const deps = test.dependencies.length ? ` deps=${test.dependencies.join(",")}` : "";
      console.log(`${test.key} [${test.priority}]${profile}${tagsText}${deps} - ${test.title}`);
    }
  });

const report = program.command("report").description("Inspect generated run reports");

report
  .command("open")
  .description("Resolve a generated run report path")
  .argument("<runId>", "run ID to inspect")
  .option("--db <path>", "SQLite DB path", ".qagent/qagent.sqlite")
  .option("--browser", "open the HTML report in the default browser", false)
  .option("--json", "print machine-readable report path output", false)
  .action(async (runId: string, options: ReportOpenOptions) => {
    try {
      const store = new SqliteRunStore(resolve(process.cwd(), options.db));
      const reportData = store.getRunReportData(runId);
      const paths = {
        runId,
        rootDir: reportData.run.artifactDir,
        htmlPath: resolve(reportData.run.artifactDir, "report.html"),
        jsonPath: resolve(reportData.run.artifactDir, "report.json"),
        junitPath: resolve(reportData.run.artifactDir, "junit.xml"),
        xlsxPath: resolve(reportData.run.artifactDir, "report.xlsx")
      };
      const existing = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, typeof value === "string" && key.endsWith("Path") ? existsSync(value) : true]));

      if (options.browser) {
        await openBrowser(paths.htmlPath);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...paths, existing }));
      } else {
        console.log(`Run: ${runId}`);
        console.log(`Report: ${paths.htmlPath}`);
        console.log(`JSON: ${paths.jsonPath}`);
        console.log(`JUnit: ${paths.junitPath}`);
        console.log(`XLSX: ${paths.xlsxPath}`);
      }
    } catch (error) {
      handleCliError(error, options.json);
    }
  });

const adapters = program.command("adapters").description("Inspect QAgent adapters");

adapters
  .option("--source <path>", "source folder to inspect")
  .action((options: { source?: string }) => {
    printAdapterList(options.source);
  });

adapters
  .command("list")
  .description("Show built-in adapter availability")
  .option("--source <path>", "source folder to inspect")
  .action((options: { source?: string }, command: Command) => {
    printAdapterList(options.source ?? command.getOptionValue("source") ?? command.parent?.getOptionValue("source"));
  });

const baseline = program.command("baseline").description("Manage regression baselines");

baseline
  .command("create")
  .description("Create a baseline from a completed run")
  .requiredOption("--run <runId>", "run ID")
  .requiredOption("--name <name>", "baseline name")
  .option("--db <path>", "SQLite DB path", ".qagent/qagent.sqlite")
  .option("--force", "replace an existing baseline name for the same project", false)
  .option("--json", "print machine-readable baseline output", false)
  .action((options: BaselineCreateOptions) => {
    try {
      const store = new SqliteRunStore(resolve(process.cwd(), options.db));
      const baselineRecord = store.createBaseline({
        runId: options.run,
        name: options.name,
        force: options.force
      });

      if (options.json) {
        console.log(JSON.stringify(baselineRecord));
      } else {
        console.log(`Baseline: ${baselineRecord.name}`);
        console.log(`Run: ${baselineRecord.runId}`);
        console.log(`ID: ${baselineRecord.id}`);
      }
    } catch (error) {
      handleCliError(error, options.json);
    }
  });

program
  .command("compare")
  .description("Compare a completed run against a regression baseline")
  .requiredOption("--run <runId>", "current run ID")
  .requiredOption("--baseline <nameOrId>", "baseline name or ID")
  .option("--db <path>", "SQLite DB path", ".qagent/qagent.sqlite")
  .option("--output <path>", "comparison output root", ".qagent/comparisons")
  .option("--json", "print machine-readable comparison output", false)
  .action(async (options: CompareOptions) => {
    try {
      const cwd = process.cwd();
      const store = new SqliteRunStore(resolve(cwd, options.db));
      const baselineRecord = store.resolveBaselineForRun({
        runId: options.run,
        baseline: options.baseline
      });
      const comparison = createRegressionComparison({
        baseline: baselineRecord,
        baselineReport: store.getRunReportData(baselineRecord.runId),
        currentReport: store.getRunReportData(options.run)
      });
      store.addComparison(comparison);
      const output = await new FileReporter().writeComparisonReports(comparison, resolve(cwd, options.output));

      if (options.json) {
        console.log(JSON.stringify({ comparison, output }));
      } else {
        printComparison(comparison, output.htmlPath ?? output.jsonPath ?? output.xlsxPath ?? output.rootDir);
      }
      process.exitCode = comparison.summary.passed ? EXIT_CODES.ok : EXIT_CODES.qualityGateFailed;
    } catch (error) {
      handleCliError(error, options.json);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  handleCliError(error, false);
});

interface RunOptions {
  url?: string;
  config?: string;
  profile?: string;
  test?: string;
  tag?: string;
  layers?: string;
  inspectOnly: boolean;
  allowSourceCommands: boolean;
  db: string;
  output: string;
  json: boolean;
}

interface TestsOptions {
  test?: string;
  tag?: string;
  profile?: string;
  json: boolean;
}

interface DashboardOptions {
  db: string;
  host: string;
  port: string;
  config?: string;
  output: string;
  allowRunTrigger: boolean;
  json: boolean;
}

interface ReportOpenOptions {
  db: string;
  browser: boolean;
  json: boolean;
}

interface BaselineCreateOptions {
  run: string;
  name: string;
  db: string;
  force: boolean;
  json: boolean;
}

interface CompareOptions {
  run: string;
  baseline: string;
  db: string;
  output: string;
  json: boolean;
}

function parseLayers(input?: string): TestLayer[] | undefined {
  return validateLayers(parseCsv(input));
}

function parseCsv(input?: string): string[] | undefined {
  if (!input) {
    return undefined;
  }

  const values = input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

async function openBrowser(path: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? { executable: "cmd", args: ["/c", "start", "", path] }
      : process.platform === "darwin"
        ? { executable: "open", args: [path] }
        : { executable: "xdg-open", args: [path] };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function validateLayers(values?: string[]): TestLayer[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  const allowed = new Set<string>(TEST_LAYERS);
  const invalid = values.filter((value) => !allowed.has(value));
  if (invalid.length > 0) {
    throw new ConfigValidationError("Invalid test layer selection.", [`Unsupported layer(s): ${invalid.join(", ")}`]);
  }
  return values as TestLayer[];
}

async function runDashboardTriggeredRun(
  request: DashboardRunTriggerRequest,
  options: {
    cwd: string;
    dbPath: string;
    artifactRoot: string;
    defaultConfigPath?: string;
  }
): Promise<DashboardRunTriggerResult> {
  const mode: TargetMode = request.url ? "cloud" : "source";
  const sourcePath = mode === "source" ? request.sourcePath ?? "." : undefined;
  const configPath = request.configPath ?? options.defaultConfigPath;
  const config = loadQAgentConfig({
    cwd: options.cwd,
    configPath,
    urlOverride: request.url,
    sourcePath,
    profile: request.profile,
    layers: validateLayers(request.layers),
    allowSourceCommands: Boolean(request.allowSourceCommands)
  });
  mkdirSync(options.artifactRoot, { recursive: true });

  const store = new SqliteRunStore(options.dbPath);
  const reporter = new FileReporter();
  const qualityRegistry = defaultQualityAdapterRegistry();
  const orchestrator = new RunOrchestrator(store, reporter, {
    cloudDiscoveryAdapter: mode === "cloud" ? new PlaywrightCloudDiscoveryAdapter() : undefined,
    browserTestAdapter: mode === "cloud" ? new PlaywrightBrowserTestAdapter() : undefined,
    apiTestAdapter: mode === "cloud" ? new HttpApiTestAdapter() : undefined,
    sourceModeAdapter: mode === "source" ? new RuntimeSourceAdapter() : undefined,
    qualityAdapters: mode === "cloud" ? qualityRegistry.list() : undefined
  });
  const outcome = await orchestrator.run({
    config,
    mode,
    cwd: options.cwd,
    artifactRoot: options.artifactRoot,
    configPath: configPath ? resolve(options.cwd, configPath) : undefined,
    url: request.url,
    sourcePath,
    profile: request.profile,
    inspectOnly: Boolean(request.inspectOnly) || !config.safety.allow_source_commands
  });

  return {
    runId: outcome.runId,
    status: outcome.status,
    exitCode: outcome.exitCode,
    summary: outcome.summary,
    reportOutput: outcome.reportOutput
  };
}

function printOutcome(outcome: {
  runId: string;
  status: string;
  summary: { passed: boolean; total: number; pass: number; fail: number; error: number; blocked: number; skipped: number };
  reportOutput: { htmlPath?: string; jsonPath?: string; junitPath?: string };
  exitCode: number;
}): void {
  console.log(`Run: ${outcome.runId} ${outcome.status}`);
  console.log(
    `Summary: total=${outcome.summary.total} pass=${outcome.summary.pass} fail=${outcome.summary.fail} error=${outcome.summary.error} blocked=${outcome.summary.blocked} skipped=${outcome.summary.skipped}`
  );
  console.log(`Report: ${outcome.reportOutput.htmlPath ?? outcome.reportOutput.jsonPath ?? outcome.reportOutput.junitPath ?? "not generated"}`);
  console.log(`Exit: ${outcome.exitCode} (${outcome.summary.passed ? "quality gate passed" : "quality gate failed"})`);
}

function printComparison(
  comparison: {
    id: string;
    baseline: { name: string; runId: string };
    currentRun: { id: string };
    summary: {
      passed: boolean;
      comparedTotal: number;
      regressions: number;
      improvements: number;
      newFailures: number;
      resolvedFailures: number;
      statusChanged: number;
      missingTests: number;
      addedTests: number;
      newFindings: number;
      resolvedFindings: number;
    };
  },
  reportPath: string
): void {
  console.log(`Comparison: ${comparison.id}`);
  console.log(`Baseline: ${comparison.baseline.name} (${comparison.baseline.runId})`);
  console.log(`Current: ${comparison.currentRun.id}`);
  console.log(
    `Summary: compared=${comparison.summary.comparedTotal} regressions=${comparison.summary.regressions} improvements=${comparison.summary.improvements} newFailures=${comparison.summary.newFailures} resolvedFailures=${comparison.summary.resolvedFailures} newFindings=${comparison.summary.newFindings} resolvedFindings=${comparison.summary.resolvedFindings} statusChanged=${comparison.summary.statusChanged} missingTests=${comparison.summary.missingTests} addedTests=${comparison.summary.addedTests}`
  );
  console.log(`Report: ${reportPath}`);
  console.log(`Exit: ${comparison.summary.passed ? EXIT_CODES.ok : EXIT_CODES.qualityGateFailed} (${comparison.summary.passed ? "regression gate passed" : "regression gate failed"})`);
}

function handleCliError(error: unknown, json: boolean): void {
  const payload = normalizeError(error);
  if (json) {
    console.error(JSON.stringify(payload));
  } else {
    console.error(payload.message);
    for (const issue of payload.issues) {
      console.error(`- ${issue}`);
    }
  }
  process.exitCode = payload.exitCode;
}

function normalizeError(error: unknown): { message: string; issues: string[]; exitCode: number } {
  if (error instanceof ConfigValidationError) {
    return { message: error.message, issues: error.issues, exitCode: EXIT_CODES.configurationError };
  }

  if (error instanceof SafetyPolicyError) {
    return { message: error.message, issues: error.issues, exitCode: EXIT_CODES.unsafeOperation };
  }

  if (error instanceof RegressionStorageError || error instanceof RegressionComparisonError) {
    return { message: error.message, issues: error.issues, exitCode: EXIT_CODES.configurationError };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
    issues: [],
    exitCode: EXIT_CODES.runnerError
  };
}

function hasNodeSqlite(): boolean {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function hasPlaywright(): boolean {
  try {
    const playwright = require("playwright") as { chromium?: { executablePath(): string } };
    return Boolean(playwright.chromium?.executablePath());
  } catch {
    return false;
  }
}

function playwrightDetail(): string {
  try {
    const pkg = require("playwright/package.json") as { version?: string };
    const playwright = require("playwright") as { chromium?: { executablePath(): string } };
    const executable = playwright.chromium?.executablePath();
    return `${pkg.version ?? "unknown"}${executable ? ` (${executable})` : ""}`;
  } catch {
    return "missing";
  }
}

function hasAxeAccessibility(): boolean {
  try {
    const availability = defaultQualityAdapterRegistry().get("axe-accessibility")?.availability();
    return Boolean(availability && !("then" in availability) && availability.status === "SUPPORTED");
  } catch {
    return false;
  }
}

function axeAccessibilityDetail(): string {
  try {
    const adapter = defaultQualityAdapterRegistry().get("axe-accessibility");
    const availability = adapter?.availability();
    if (!adapter || !availability || "then" in availability) {
      return "unknown";
    }
    return availability.status === "SUPPORTED" ? `available (${adapter.capabilities.join(",")})` : availability.reason ?? "unavailable";
  } catch {
    return "missing";
  }
}

function hasBrowserPerformance(): boolean {
  try {
    const availability = defaultQualityAdapterRegistry().get("browser-performance")?.availability();
    return Boolean(availability && !("then" in availability) && availability.status === "SUPPORTED");
  } catch {
    return false;
  }
}

function browserPerformanceDetail(): string {
  try {
    const adapter = defaultQualityAdapterRegistry().get("browser-performance");
    const availability = adapter?.availability();
    if (!adapter || !availability || "then" in availability) {
      return "unknown";
    }
    return availability.status === "SUPPORTED" ? `available (${adapter.capabilities.join(",")})` : availability.reason ?? "unavailable";
  } catch {
    return "missing";
  }
}

function hasPassiveSecurity(): boolean {
  try {
    const availability = defaultQualityAdapterRegistry().get("passive-security")?.availability();
    return Boolean(availability && !("then" in availability) && availability.status === "SUPPORTED");
  } catch {
    return false;
  }
}

function passiveSecurityDetail(): string {
  try {
    const adapter = defaultQualityAdapterRegistry().get("passive-security");
    const availability = adapter?.availability();
    if (!adapter || !availability || "then" in availability) {
      return "unknown";
    }
    return availability.status === "SUPPORTED" ? `available (${adapter.capabilities.join(",")})` : availability.reason ?? "unavailable";
  } catch {
    return "missing";
  }
}

function hasHttpLoadSmoke(): boolean {
  try {
    const availability = defaultQualityAdapterRegistry().get("http-load-smoke")?.availability();
    return Boolean(availability && !("then" in availability) && availability.status === "SUPPORTED");
  } catch {
    return false;
  }
}

function httpLoadSmokeDetail(): string {
  try {
    const adapter = defaultQualityAdapterRegistry().get("http-load-smoke");
    const availability = adapter?.availability();
    if (!adapter || !availability || "then" in availability) {
      return "unknown";
    }
    return availability.status === "SUPPORTED" ? `available (${adapter.capabilities.join(",")})` : availability.reason ?? "unavailable";
  } catch {
    return "missing";
  }
}

function printAdapterList(source?: string): void {
  console.log("qagent-foundation: available");
  console.log(`browser-playwright: ${hasPlaywright() ? "available" : "missing"}`);
  console.log("api-http: available");
  for (const adapter of defaultQualityAdapterRegistry().list()) {
    const availability = adapter.availability();
    if ("then" in availability) {
      console.log(`${adapter.id}: unknown capabilities=${adapter.capabilities.join(",")}`);
    } else {
      console.log(`${adapter.id}: ${availability.status} capabilities=${adapter.capabilities.join(",")}${availability.reason ? ` reason=${availability.reason}` : ""}`);
    }
  }
  console.log("zap/k6/lighthouse: planned external adapters");
  for (const adapter of defaultRuntimeAdapterRegistry().summaries()) {
    console.log(`runtime-${adapter.id}: ${adapter.support} capabilities=${adapter.capabilities.join(",")}`);
  }
  if (source) {
    const detection = detectRuntime(resolve(process.cwd(), source));
    console.log(`runtime-detection: ${detection.adapterId} ${detection.status} (${detection.confidence})`);
    console.log(`runtime: ${detection.runtime ?? "unknown"} framework=${detection.framework ?? "unknown"} packageManager=${detection.packageManager ?? ""}`);
    console.log(`markers: ${detection.markers?.length ? detection.markers.join(", ") : "none"}`);
  }
}
