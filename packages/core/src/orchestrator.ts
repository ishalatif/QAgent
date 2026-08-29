import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ApiEndpoint,
  AuthProfileReport,
  BrowserTestMetadata,
  DiscoveredPage,
  EvidenceRef,
  Finding,
  NormalizedResult,
  ProjectRecord,
  QualityAdapterCategory,
  QAgentConfig,
  QualityGateSummary,
  ReportOutput,
  RunRecord,
  RunReportData,
  RunStatus,
  SourceCommandReport,
  SourceProjectReport,
  TargetMode,
  TargetRecord
} from "#contracts";
import { EXIT_CODES } from "#contracts";
import { redactText } from "./redaction.js";
import { assertValidRunTransition } from "./state-machine.js";
import { validateTargetSafety } from "./safety.js";

export interface RunStore {
  initialize(): void;
  upsertProject(input: { id: string; name: string; settingsRef?: string; createdAt: string }): ProjectRecord;
  upsertTarget(input: {
    id: string;
    projectId: string;
    mode: TargetMode;
    url?: string;
    sourcePath?: string;
    environment: QAgentConfig["target"]["environment"];
    allowedHosts: string[];
    createdAt: string;
  }): TargetRecord;
  createRun(input: {
    id: string;
    projectId: string;
    targetId: string;
    status: RunStatus;
    startedAt: string;
    toolVersions: Record<string, string>;
    artifactDir: string;
    createdAt: string;
    updatedAt: string;
  }): RunRecord;
  updateRunStatus(runId: string, status: RunStatus, fields?: { completedAt?: string; summary?: QualityGateSummary }): void;
  addResult(result: NormalizedResult): void;
  addDiscoveredPages(pages: DiscoveredPage[]): void;
  addApiEndpoints(endpoints: ApiEndpoint[]): void;
  addFindings(runId: string, findings: Finding[]): void;
  addEvidence(runId: string, evidence: EvidenceRef[]): void;
  addSourceProject(runId: string, sourceProject?: SourceProjectReport): void;
  addSourceCommands(runId: string, commands: SourceCommandReport[]): void;
  addAuthProfiles(runId: string, profiles: AuthProfileReport[]): void;
  addRegisteredTests(runId: string, tests: BrowserTestMetadata[]): void;
  getRunReportData(runId: string): RunReportData;
}

export interface Reporter {
  writeReports(data: RunReportData): Promise<ReportOutput>;
}

export interface RunRequest {
  config: QAgentConfig;
  mode: TargetMode;
  cwd: string;
  artifactRoot: string;
  configPath?: string;
  url?: string;
  sourcePath?: string;
  profile?: string;
  testKeys?: string[];
  tags?: string[];
  inspectOnly?: boolean;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  summary: QualityGateSummary;
  reportOutput: ReportOutput;
  exitCode: number;
}

export interface CloudDiscoveryRequest {
  runId: string;
  url: string;
  config: QAgentConfig;
  artifactDir: string;
}

export interface CloudDiscoveryOutput {
  results: NormalizedResult[];
  sourceProject?: SourceProjectReport;
  sourceCommands: SourceCommandReport[];
  pages: DiscoveredPage[];
  apiEndpoints: ApiEndpoint[];
  findings: Finding[];
  evidence: EvidenceRef[];
  authProfiles: AuthProfileReport[];
  registeredTests: BrowserTestMetadata[];
}

export interface SourceModeRequest {
  runId: string;
  sourcePath: string;
  config: QAgentConfig;
  artifactDir: string;
  inspectOnly: boolean;
}

export interface SourceModeOutput {
  results: NormalizedResult[];
  findings: Finding[];
  evidence: EvidenceRef[];
  sourceProject?: SourceProjectReport;
  sourceCommands: SourceCommandReport[];
}

export interface SourceModeAdapter {
  id: string;
  version: string;
  runSource(request: SourceModeRequest): Promise<SourceModeOutput>;
}

export interface CloudDiscoveryAdapter {
  id: string;
  version: string;
  discover(request: CloudDiscoveryRequest): Promise<CloudDiscoveryOutput>;
}

export interface BrowserTestRequest {
  runId: string;
  url: string;
  config: QAgentConfig;
  artifactDir: string;
  sessionRoot: string;
  profile?: string;
  testKeys?: string[];
  tags?: string[];
}

export interface BrowserTestOutput {
  results: NormalizedResult[];
  findings: Finding[];
  evidence: EvidenceRef[];
  authProfiles: AuthProfileReport[];
  registeredTests: BrowserTestMetadata[];
}

export interface BrowserTestAdapter {
  id: string;
  version: string;
  listTests(): BrowserTestMetadata[];
  runTests(request: BrowserTestRequest): Promise<BrowserTestOutput>;
}

export interface ApiTestRequest {
  runId: string;
  url: string;
  config: QAgentConfig;
  artifactDir: string;
  profile?: string;
}

export interface ApiTestOutput {
  results: NormalizedResult[];
  findings: Finding[];
  evidence: EvidenceRef[];
}

export interface ApiTestAdapter {
  id: string;
  version: string;
  runTests(request: ApiTestRequest): Promise<ApiTestOutput>;
}

export interface QualityAdapterAvailability {
  status: "SUPPORTED" | "UNAVAILABLE";
  reason?: string;
}

export interface QualityAdapterRequest {
  runId: string;
  url: string;
  config: QAgentConfig;
  artifactDir: string;
  sessionRoot: string;
  profile?: string;
  discoveredPages: DiscoveredPage[];
}

export interface QualityAdapterOutput {
  results: NormalizedResult[];
  findings: Finding[];
  evidence: EvidenceRef[];
}

export interface QualityAdapter {
  id: string;
  version: string;
  category: QualityAdapterCategory;
  capabilities: string[];
  availability(): QualityAdapterAvailability | Promise<QualityAdapterAvailability>;
  execute(request: QualityAdapterRequest): Promise<QualityAdapterOutput>;
}

export interface RunOrchestratorOptions {
  cloudDiscoveryAdapter?: CloudDiscoveryAdapter;
  browserTestAdapter?: BrowserTestAdapter;
  sourceModeAdapter?: SourceModeAdapter;
  apiTestAdapter?: ApiTestAdapter;
  qualityAdapters?: QualityAdapter[];
}

export class RunOrchestrator {
  constructor(
    private readonly store: RunStore,
    private readonly reporter: Reporter,
    private readonly options: RunOrchestratorOptions = {},
    private readonly clock: () => Date = () => new Date()
  ) {}

  async run(request: RunRequest): Promise<RunOutcome> {
    validateTargetSafety({ config: request.config, url: request.url });

    const now = this.now();
    const projectId = stableId("project", request.config.project.name);
    const targetId = stableId("target", [
      request.mode,
      request.url ?? request.config.target.url ?? "",
      request.sourcePath ?? "",
      request.config.target.environment
    ]);
    const runId = createRunId(now);
    const artifactDir = resolve(request.artifactRoot, runId);
    const results: NormalizedResult[] = [];

    this.store.initialize();
    this.store.upsertProject({
      id: projectId,
      name: request.config.project.name,
      settingsRef: request.configPath,
      createdAt: now
    });
    this.store.upsertTarget({
      id: targetId,
      projectId,
      mode: request.mode,
      url: request.url ?? request.config.target.url,
      sourcePath: request.sourcePath ? resolve(request.cwd, request.sourcePath) : undefined,
      environment: request.config.target.environment,
      allowedHosts: request.config.target.allowed_hosts ?? [],
      createdAt: now
    });

    let status: RunStatus = "CREATED";
    this.store.createRun({
      id: runId,
      projectId,
      targetId,
      status,
      startedAt: now,
      toolVersions: collectToolVersions(),
      artifactDir,
      createdAt: now,
      updatedAt: now
    });

    try {
      status = this.transition(runId, status, "VALIDATING");
      const configResult = this.result({
        runId,
        testKey: "config.schema",
        layer: "config",
        title: "QAgent config schema and defaults",
        status: "PASS",
        targetRef: targetRef(request),
        expected: "valid qa.config.yaml contract",
        actual: "config loaded and normalized"
      });
      results.push(configResult);
      this.store.addResult(configResult);

      status = this.transition(runId, status, "RUNNING");
      const modeOutput = await this.modeResults(request, runId, artifactDir);
      this.store.addSourceProject(runId, modeOutput.sourceProject);
      this.store.addSourceCommands(runId, modeOutput.sourceCommands);
      this.store.addDiscoveredPages(modeOutput.pages);
      this.store.addApiEndpoints(modeOutput.apiEndpoints);
      this.store.addFindings(runId, modeOutput.findings);
      this.store.addEvidence(runId, modeOutput.evidence);
      this.store.addAuthProfiles(runId, modeOutput.authProfiles);
      this.store.addRegisteredTests(runId, modeOutput.registeredTests);
      for (const result of modeOutput.results) {
        results.push(result);
        this.store.addResult(result);
      }

      const reportingResult = this.result({
        runId,
        testKey: "reporting.generate",
        layer: "reporting",
        title: "Generate JSON, HTML, and JUnit reports",
        status: "PASS",
        targetRef: targetRef(request),
        expected: request.config.report.formats,
        actual: "report generation requested"
      });
      results.push(reportingResult);
      this.store.addResult(reportingResult);

      const completedAt = this.now();
      const summary = summarizeResults(results, elapsedMs(now, completedAt));
      status = this.transition(runId, status, "COMPLETED", { completedAt, summary });

      const reportData = this.store.getRunReportData(runId);
      const reportOutput = await this.reporter.writeReports(reportData);

      return {
        runId,
        status,
        summary,
        reportOutput,
        exitCode: summary.passed ? EXIT_CODES.ok : EXIT_CODES.qualityGateFailed
      };
    } catch (error) {
      const failedAt = this.now();
      const summary = summarizeResults(results, elapsedMs(now, failedAt), false);
      if (status !== "FAILED") {
        this.transition(runId, status, "FAILED", { completedAt: failedAt, summary });
      }
      throw error;
    }
  }

  private async modeResults(request: RunRequest, runId: string, artifactDir: string): Promise<CloudDiscoveryOutput> {
    if (request.mode === "source") {
      const sourcePath = request.sourcePath ? resolve(request.cwd, request.sourcePath) : request.cwd;
      const foundationResults = this.sourceFoundationResults(request, runId);
      if (foundationResults.some((result) => result.status === "BLOCKED")) {
        return emptyDiscoveryOutput(foundationResults);
      }
      if (!this.options.sourceModeAdapter) {
        return emptyDiscoveryOutput([
          ...foundationResults,
          this.result({
            runId,
            testKey: "source.runtime.adapter",
            layer: "source",
            title: "Runtime adapter negotiation",
            status: "SKIPPED",
            targetRef: sourcePath,
            expected: "Node/Python/Generic adapters in Sprint S5",
            actual: "source adapter not configured"
          })
        ]);
      }
      try {
        const sourceOutput = await this.options.sourceModeAdapter.runSource({
          runId,
          sourcePath,
          config: request.config,
          artifactDir,
          inspectOnly: Boolean(request.inspectOnly)
        });
        return {
          ...emptyDiscoveryOutput(foundationResults),
          results: [...foundationResults, ...sourceOutput.results],
          findings: sourceOutput.findings,
          evidence: sourceOutput.evidence,
          sourceProject: sourceOutput.sourceProject,
          sourceCommands: sourceOutput.sourceCommands
        };
      } catch (error) {
        if (isConfigurationError(error)) {
          throw error;
        }
        return emptyDiscoveryOutput([
          ...foundationResults,
          this.adapterErrorResult({
            request,
            runId,
            testKey: "source.runtime.adapter",
            layer: "source",
            title: "Runtime adapter negotiation",
            expected: "source adapter completes detection and returns normalized output",
            error
          })
        ]);
      }
    }

    const url = request.url ?? request.config.target.url;
    const wantsCloudDiscovery = request.config.tests.layers.some((layer) => layer === "browser" || layer === "api" || layer === "accessibility" || layer === "performance" || layer === "security");
    const wantsApiTests = request.config.tests.layers.some((layer) => layer === "api" || layer === "authorization");
    const wantsQualityTests = request.config.tests.layers.some((layer) => layer === "accessibility" || layer === "performance" || layer === "security" || layer === "load");
    const outputs: CloudDiscoveryOutput[] = [];
    if (url && wantsCloudDiscovery && this.options.cloudDiscoveryAdapter) {
      try {
        outputs.push(
          await this.options.cloudDiscoveryAdapter.discover({
            runId,
            url,
            config: request.config,
            artifactDir
          })
        );
      } catch (error) {
        if (isConfigurationError(error)) {
          throw error;
        }
        outputs.push(
          emptyDiscoveryOutput([
            this.adapterErrorResult({
              request,
              runId,
              testKey: "cloud.discovery.adapter",
              layer: "browser",
              title: "Cloud browser discovery adapter",
              expected: "adapter completes discovery and returns normalized output",
              error
            })
          ])
        );
      }
    }

    const hasAuthProfiles = Object.keys(request.config.auth.profiles).length > 0;
    if (url && wantsCloudDiscovery && hasAuthProfiles && this.options.browserTestAdapter) {
      try {
        const testOutput = await this.options.browserTestAdapter.runTests({
          runId,
          url,
          config: request.config,
          artifactDir,
          sessionRoot: resolve(request.cwd, ".qagent", "sessions"),
          profile: request.profile,
          testKeys: request.testKeys,
          tags: request.tags
        });
        outputs.push({
          pages: [],
          apiEndpoints: [],
          sourceCommands: [],
          results: testOutput.results,
          findings: testOutput.findings,
          evidence: testOutput.evidence,
          authProfiles: testOutput.authProfiles,
          registeredTests: testOutput.registeredTests
        });
      } catch (error) {
        if (isConfigurationError(error)) {
          throw error;
        }
        outputs.push(
          emptyDiscoveryOutput([
            this.adapterErrorResult({
              request,
              runId,
              testKey: "browser.tests.adapter",
              layer: "browser",
              title: "Browser test adapter",
              expected: "adapter completes registered browser tests",
              error
            })
          ])
        );
      }
    }

    if (url && wantsApiTests && this.options.apiTestAdapter) {
      try {
        const apiOutput = await this.options.apiTestAdapter.runTests({
          runId,
          url,
          config: request.config,
          artifactDir,
          profile: request.profile
        });
        outputs.push({
          pages: [],
          apiEndpoints: [],
          sourceCommands: [],
          results: apiOutput.results,
          findings: apiOutput.findings,
          evidence: apiOutput.evidence,
          authProfiles: [],
          registeredTests: []
        });
      } catch (error) {
        if (isConfigurationError(error)) {
          throw error;
        }
        outputs.push(
          emptyDiscoveryOutput([
            this.adapterErrorResult({
              request,
              runId,
              testKey: "api.tests.adapter",
              layer: "api",
              title: "API/RBAC test adapter",
              expected: "adapter completes configured API assertions",
              error
            })
          ])
        );
      }
    }

    if (url && wantsQualityTests) {
      const qualityOutputs = await this.runQualityAdapters({
        request,
        runId,
        artifactDir,
        url,
        discoveredPages: outputs.flatMap((output) => output.pages)
      });
      outputs.push(...qualityOutputs);
    }

    if (outputs.length > 0) {
      return mergeOutputs(outputs);
    }

    return emptyDiscoveryOutput([
      this.result({
        runId,
        testKey: "cloud.discovery.adapter",
        layer: "browser",
        title: "Cloud browser discovery adapter",
        status: "SKIPPED",
        targetRef: targetRef(request),
        expected: "Playwright discovery in Sprint S2",
        actual: "foundation run persisted without contacting target"
      }),
      this.result({
        runId,
        testKey: "api.inventory.adapter",
        layer: "api",
        title: "Observed API inventory adapter",
        status: "SKIPPED",
        targetRef: targetRef(request),
        expected: "network/API inventory in Sprint S2/S6",
        actual: "adapter boundary reserved"
      })
    ]);
  }

  private async runQualityAdapters(input: {
    request: RunRequest;
    runId: string;
    artifactDir: string;
    url: string;
    discoveredPages: DiscoveredPage[];
  }): Promise<CloudDiscoveryOutput[]> {
    const wanted = new Set(input.request.config.tests.layers);
    const adapters = [...(this.options.qualityAdapters ?? [])].filter((adapter) => wanted.has(adapter.category));

    if (adapters.length === 0) {
      return [
        emptyDiscoveryOutput([
          this.result({
            runId: input.runId,
            testKey: "quality.adapters.configured",
            layer: "accessibility",
            title: "Quality adapter registry",
            status: "SKIPPED",
            targetRef: targetRef(input.request),
            expected: "quality adapter registered for requested layer",
            actual: "no matching quality adapter configured"
          })
        ])
      ];
    }

    const outputs: CloudDiscoveryOutput[] = [];
    for (const adapter of adapters.sort((left, right) => left.id.localeCompare(right.id))) {
      try {
        const availability = await adapter.availability();
        if (availability.status !== "SUPPORTED") {
          outputs.push(
            emptyDiscoveryOutput([
              this.result({
                runId: input.runId,
                testKey: `${adapter.category}.${adapter.id}.available`,
                layer: adapter.category,
                title: `${adapter.id} availability`,
                status: "BLOCKED",
                targetRef: targetRef(input.request),
                expected: "quality adapter available",
                actual: availability.reason ?? "adapter unavailable",
                error: availability.reason ?? "adapter unavailable"
              })
            ])
          );
          continue;
        }

        const output = await adapter.execute({
          runId: input.runId,
          url: input.url,
          config: input.request.config,
          artifactDir: input.artifactDir,
          sessionRoot: resolve(input.request.cwd, ".qagent", "sessions"),
          profile: input.request.profile,
          discoveredPages: input.discoveredPages
        });
        outputs.push({
          pages: [],
          apiEndpoints: [],
          sourceCommands: [],
          results: output.results,
          findings: output.findings,
          evidence: output.evidence,
          authProfiles: [],
          registeredTests: []
        });
      } catch (error) {
        if (isConfigurationError(error)) {
          throw error;
        }
        outputs.push(
          emptyDiscoveryOutput([
            this.adapterErrorResult({
              request: input.request,
              runId: input.runId,
              testKey: `${adapter.category}.${adapter.id}.adapter`,
              layer: adapter.category,
              title: `${adapter.id} quality adapter`,
              expected: "quality adapter completes and returns normalized output",
              error
            })
          ])
        );
      }
    }
    return outputs;
  }

  private sourceFoundationResults(request: RunRequest, runId: string): NormalizedResult[] {
    const sourcePath = request.sourcePath ? resolve(request.cwd, request.sourcePath) : request.cwd;
    const exists = existsSync(sourcePath) && statSync(sourcePath).isDirectory();

    return [
      this.result({
        runId,
        testKey: "source.path.readable",
        layer: "source",
        title: "Source folder is readable",
        status: exists ? "PASS" : "BLOCKED",
        targetRef: sourcePath,
        expected: "readable source directory",
        actual: exists ? "source directory found" : "source directory missing or not a directory"
      })
    ];
  }

  private transition(
    runId: string,
    from: RunStatus,
    to: RunStatus,
    fields?: { completedAt?: string; summary?: QualityGateSummary }
  ): RunStatus {
    assertValidRunTransition(from, to);
    this.store.updateRunStatus(runId, to, fields);
    return to;
  }

  private result(input: Omit<NormalizedResult, "id" | "startedAt" | "durationMs" | "evidenceRefs" | "findingRefs" | "adapterId" | "adapterVersion">): NormalizedResult {
    return {
      ...input,
      id: randomUUID(),
      startedAt: this.now(),
      durationMs: 0,
      evidenceRefs: [],
      findingRefs: [],
      adapterId: "qagent-foundation",
      adapterVersion: "0.1.0"
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private adapterErrorResult(input: {
    request: RunRequest;
    runId: string;
    testKey: string;
    layer: NormalizedResult["layer"];
    title: string;
    expected: unknown;
    error: unknown;
  }): NormalizedResult {
    const message = redactText(input.error instanceof Error ? input.error.message : String(input.error), input.request.config.report.redact_headers);
    return this.result({
      runId: input.runId,
      testKey: input.testKey,
      layer: input.layer,
      title: input.title,
      status: "ERROR",
      targetRef: targetRef(input.request),
      expected: input.expected,
      actual: {
        error: message
      },
      error: message
    });
  }
}

function emptyDiscoveryOutput(results: NormalizedResult[]): CloudDiscoveryOutput {
  return {
    results,
    sourceCommands: [],
    pages: [],
    apiEndpoints: [],
    findings: [],
    evidence: [],
    authProfiles: [],
    registeredTests: []
  };
}

function mergeOutputs(outputs: CloudDiscoveryOutput[]): CloudDiscoveryOutput {
  return {
    results: outputs.flatMap((output) => output.results),
    sourceProject: outputs.find((output) => output.sourceProject)?.sourceProject,
    sourceCommands: outputs.flatMap((output) => output.sourceCommands ?? []),
    pages: outputs.flatMap((output) => output.pages),
    apiEndpoints: outputs.flatMap((output) => output.apiEndpoints),
    findings: outputs.flatMap((output) => output.findings),
    evidence: outputs.flatMap((output) => output.evidence),
    authProfiles: outputs.flatMap((output) => output.authProfiles),
    registeredTests: outputs.flatMap((output) => output.registeredTests)
  };
}

function isConfigurationError(error: unknown): boolean {
  return error instanceof Error && error.name === "ConfigValidationError";
}

export function summarizeResults(results: NormalizedResult[], durationMs: number, forceFailed = false): QualityGateSummary {
  const summary: QualityGateSummary = {
    passed: false,
    total: results.length,
    pass: results.filter((result) => result.status === "PASS").length,
    fail: results.filter((result) => result.status === "FAIL").length,
    error: results.filter((result) => result.status === "ERROR").length,
    blocked: results.filter((result) => result.status === "BLOCKED").length,
    skipped: results.filter((result) => result.status === "SKIPPED").length,
    durationMs
  };

  summary.passed = !forceFailed && summary.fail === 0 && summary.error === 0 && summary.blocked === 0;
  return summary;
}

function collectToolVersions(): Record<string, string> {
  return {
    node: process.versions.node,
    qagent: "0.1.0"
  };
}

function createRunId(startedAt: string): string {
  const compactDate = startedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  return `run_${compactDate}_${randomUUID().slice(0, 8)}`;
}

function stableId(prefix: string, input: unknown): string {
  const raw = Array.isArray(input) ? input.join("|") : String(input);
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = (hash * 31 + raw.charCodeAt(index)) >>> 0;
  }
  return `${prefix}_${hash.toString(16).padStart(8, "0")}`;
}

function targetRef(request: RunRequest): string {
  if (request.mode === "source") {
    return request.sourcePath ? resolve(request.cwd, request.sourcePath) : request.cwd;
  }
  return request.url ?? request.config.target.url ?? "unknown-url";
}

function elapsedMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}
