import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  CapabilityState,
  DetectionResult,
  EvidenceRef,
  NormalizedResult,
  QAgentConfig,
  ResultStatus,
  RuntimeCapability,
  RuntimeSupportState,
  SourceCapabilityName,
  SourceCapabilityReport,
  SourceCommandConfig,
  SourceCommandDescriptor,
  SourceCommandName,
  SourceCommandReport,
  SourceProjectReport,
  StepResult
} from "#contracts";
import { SOURCE_CAPABILITIES } from "#contracts";
import type { SourceModeAdapter, SourceModeOutput, SourceModeRequest } from "#core";
import { redactText } from "#core";
import { SafeProcessRunner } from "#process-runner";

const ADAPTER_VERSION = "0.1.0";
const SAFE_COMMAND_CAPABILITIES = ["lint", "typeCheck", "test", "build"] as const;
const COMMAND_NAME_BY_CAPABILITY: Record<(typeof SAFE_COMMAND_CAPABILITIES)[number], SourceCommandName> = {
  lint: "lint",
  typeCheck: "typecheck",
  test: "test",
  build: "build"
};

const MARKER_ORDER = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "poetry.lock",
  "pytest.ini",
  "tox.ini",
  "setup.cfg",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "go.mod",
  "global.json"
] as const;

const IGNORED_DIRECTORIES = new Set([".git", ".qagent", "node_modules", "dist", "build", "coverage", "vendor", "venv", ".venv"]);

export interface RuntimeAdapterInput {
  sourcePath: string;
  config: QAgentConfig;
  detection: DetectionResult;
  inspectOnly: boolean;
}

export interface RuntimeAdapterInspection {
  sourceProject: SourceProjectReport;
  commandPlan: SourceCommandDescriptor[];
  inspectStatus: ResultStatus;
  inspectReason?: string;
}

export interface RuntimeAdapter {
  id: string;
  runtime: string;
  version: string;
  support: RuntimeSupportState;
  inspect(input: RuntimeAdapterInput): RuntimeAdapterInspection;
}

export interface RuntimeAdapterSummary {
  id: string;
  runtime: string;
  version: string;
  support: RuntimeSupportState;
  capabilities: SourceCapabilityName[];
}

export class DuplicateRuntimeAdapterIdError extends Error {
  constructor(adapterId: string) {
    super(`Runtime adapter already registered: ${adapterId}`);
    this.name = "DuplicateRuntimeAdapterIdError";
  }
}

export class RuntimeAdapterRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): this {
    if (this.adapters.has(adapter.id)) {
      throw new DuplicateRuntimeAdapterIdError(adapter.id);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  all(): RuntimeAdapter[] {
    return [...this.adapters.values()];
  }

  get(adapterId: string): RuntimeAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  resolve(detection: DetectionResult, config?: QAgentConfig): RuntimeAdapter | undefined {
    const configured = normalizeAdapterId(config?.source?.adapter);
    if (configured && configured !== "auto") {
      return this.adapters.get(configured);
    }
    return this.adapters.get(detection.adapterId);
  }

  summaries(): RuntimeAdapterSummary[] {
    return this.all().map((adapter) => ({
      id: adapter.id,
      runtime: adapter.runtime,
      version: adapter.version,
      support: adapter.support,
      capabilities: adapterSummaryCapabilities(adapter)
    }));
  }
}

export class RuntimeSourceAdapter implements SourceModeAdapter {
  readonly id = "runtime-source";
  readonly version = ADAPTER_VERSION;

  constructor(private readonly registry: RuntimeAdapterRegistry = defaultRuntimeAdapterRegistry()) {}

  async runSource(request: SourceModeRequest): Promise<SourceModeOutput> {
    const detectionResult = detectRuntime(request.sourcePath, request.config);
    const adapter = this.registry.resolve(detectionResult, request.config);
    const output: SourceModeOutput = {
      results: [
        sourceResult({
          request,
          testKey: "source.detect",
          title: "Detect source runtime",
          status: "PASS",
          targetRef: request.sourcePath,
          expected: "deterministic runtime markers",
          actual: summarizeDetection(detectionResult)
        })
      ],
      findings: [],
      evidence: [],
      sourceCommands: []
    };

    if (!adapter) {
      const reason = `No runtime adapter is registered for ${detectionResult.adapterId}.`;
      output.sourceProject = sourceProjectFromDetection({
        detection: detectionResult,
        sourcePath: request.sourcePath,
        inspectOnly: request.inspectOnly,
        capabilities: sourceReportsFromRuntimeCapabilities(baseCapabilities("UNAVAILABLE", reason)),
        reason
      });
      output.results.push(
        sourceResult({
          request,
          testKey: "source.adapter.select",
          title: "Select runtime adapter",
          status: "BLOCKED",
          targetRef: request.sourcePath,
          expected: "registered runtime adapter",
          actual: { adapterId: detectionResult.adapterId, support: "UNSUPPORTED", reason },
          error: reason
        })
      );
      return output;
    }

    let inspection: RuntimeAdapterInspection;
    try {
      inspection = adapter.inspect({
        sourcePath: request.sourcePath,
        config: request.config,
        detection: detectionResult,
        inspectOnly: request.inspectOnly
      });
    } catch (error) {
      const message = sanitize(String(error instanceof Error ? error.message : error), request.config);
      output.sourceProject = sourceProjectFromDetection({
        detection: detectionResult,
        sourcePath: request.sourcePath,
        inspectOnly: request.inspectOnly,
        capabilities: sourceReportsFromRuntimeCapabilities(baseCapabilities("UNAVAILABLE", message)),
        reason: message
      });
      output.results.push(
        sourceResult({
          request,
          testKey: "source.adapter.select",
          title: "Select runtime adapter",
          status: "PASS",
          targetRef: request.sourcePath,
          expected: "registered runtime adapter",
          actual: { adapterId: adapter.id, support: adapter.support }
        }),
        sourceResult({
          request,
          testKey: "source.inspect",
          title: "Inspect source project metadata",
          status: "ERROR",
          targetRef: request.sourcePath,
          expected: "adapter inspection completes",
          actual: { error: message },
          error: message
        })
      );
      return output;
    }

    output.sourceProject = inspection.sourceProject;
    const selected = isExecutableSupport(inspection.sourceProject.support);
    const selectionReason = selected ? undefined : inspection.sourceProject.reason ?? `Runtime ${inspection.sourceProject.runtime} is not executable in S5.`;
    output.results.push(
      sourceResult({
        request,
        testKey: "source.adapter.select",
        title: "Select runtime adapter",
        status: selected ? "PASS" : "BLOCKED",
        targetRef: request.sourcePath,
        expected: "SUPPORTED or LIMITED runtime adapter",
        actual: {
          adapterId: inspection.sourceProject.adapterId,
          support: inspection.sourceProject.support,
          runtime: inspection.sourceProject.runtime,
          framework: inspection.sourceProject.framework
        },
        error: selectionReason
      })
    );

    output.results.push(
      sourceResult({
        request,
        testKey: "source.inspect",
        title: "Inspect source project metadata",
        status: selected ? inspection.inspectStatus : "SKIPPED",
        targetRef: request.sourcePath,
        expected: "project metadata and source capabilities",
        actual: {
          runtime: inspection.sourceProject.runtime,
          framework: inspection.sourceProject.framework,
          packageManager: inspection.sourceProject.packageManager,
          markers: inspection.sourceProject.markers,
          capabilities: inspection.sourceProject.capabilities
        },
        error: selected && inspection.inspectStatus !== "PASS" ? inspection.inspectReason : undefined
      })
    );

    if (!selected || inspection.inspectStatus !== "PASS" || inspection.commandPlan.length === 0) {
      return output;
    }

    const execution = await executeCommandPlan({ request, commands: inspection.commandPlan });
    output.results.push(...execution.results);
    output.evidence.push(...execution.evidence);
    output.sourceCommands.push(...execution.sourceCommands);
    return output;
  }
}

export function defaultRuntimeAdapterRegistry(): RuntimeAdapterRegistry {
  return new RuntimeAdapterRegistry()
    .register(new NodeAdapter())
    .register(new PythonAdapter())
    .register(new GenericAdapter())
    .register(new PlannedAdapter("php", "php"))
    .register(new PlannedAdapter("java", "java"))
    .register(new PlannedAdapter("dotnet", "dotnet"))
    .register(new PlannedAdapter("go", "go"));
}

export function detectRuntime(sourcePath: string, config?: QAgentConfig): DetectionResult {
  const root = resolve(sourcePath);
  const markers = detectMarkers(root);
  const markerSet = new Set(markers);
  const configured = normalizeAdapterId(config?.source?.adapter);
  const hasExplicitCommands = Object.keys(config?.source?.commands ?? {}).length > 0;

  if (configured && configured !== "auto") {
    return explicitDetection(configured, root, markers, hasExplicitCommands);
  }

  if (markerSet.has("package.json")) {
    const packageJson = readPackageJson(root);
    return detection({
      adapterId: "node",
      runtime: "node",
      framework: packageJson.ok ? detectNodeFramework(packageJson.value) : "unknown",
      packageManager: detectPackageManager(markerSet),
      status: "SUPPORTED",
      confidence: "high",
      markers,
      reason: packageJson.ok ? undefined : packageJson.reason,
      capabilities: baseCapabilities("UNAVAILABLE")
    });
  }

  if (hasAny(markerSet, ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json", "tsconfig.json"])) {
    return detection({
      adapterId: "node",
      runtime: "node",
      framework: "unknown",
      packageManager: detectPackageManager(markerSet),
      status: "LIMITED",
      confidence: "medium",
      markers,
      reason: "Node markers found without package.json; package scripts cannot be inspected.",
      capabilities: baseCapabilities("UNAVAILABLE")
    });
  }

  if (hasAny(markerSet, ["pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock"])) {
    return detection({
      adapterId: "python",
      runtime: "python",
      framework: detectPythonFramework(root),
      status: "SUPPORTED",
      confidence: "high",
      markers,
      capabilities: baseCapabilities("UNAVAILABLE")
    });
  }

  const planned = plannedRuntime(markerSet);
  if (planned) {
    return detection({
      adapterId: planned,
      runtime: planned,
      framework: "unknown",
      status: "PLANNED",
      confidence: "high",
      markers,
      reason: `${planned} runtime markers are recognized but not executable in S5.`,
      capabilities: baseCapabilities("NOT_APPLICABLE")
    });
  }

  if (hasExplicitCommands) {
    return detection({
      adapterId: "generic",
      runtime: "generic",
      framework: "explicit-commands",
      status: "LIMITED",
      confidence: "high",
      markers,
      reason: "Generic adapter selected from explicit source.commands.",
      capabilities: baseCapabilities("UNAVAILABLE")
    });
  }

  return detection({
    adapterId: "unknown",
    runtime: "unknown",
    framework: "unknown",
    status: "UNSUPPORTED",
    confidence: "none",
    markers,
    reason: "No supported source runtime markers were found.",
    capabilities: baseCapabilities("UNAVAILABLE")
  });
}

export class NodeAdapter implements RuntimeAdapter {
  readonly id = "node";
  readonly runtime = "node";
  readonly version = ADAPTER_VERSION;
  readonly support = "SUPPORTED" as const;

  inspect(input: RuntimeAdapterInput): RuntimeAdapterInspection {
    const root = resolve(input.sourcePath);
    const packageJson = readPackageJson(root);
    const packageManager = detectPackageManager(new Set(input.detection.markers ?? input.detection.manifests));

    if (!packageJson.ok) {
      const capabilities = sourceReportsFromRuntimeCapabilities(baseCapabilities("UNAVAILABLE", packageJson.reason));
      const detectCapability = capabilities.find((capability) => capability.name === "detect");
      if (detectCapability) {
        detectCapability.state = "SUPPORTED";
        detectCapability.reason = undefined;
      }
      return {
        sourceProject: sourceProjectFromDetection({
          detection: { ...input.detection, packageManager, reason: packageJson.reason },
          sourcePath: root,
          inspectOnly: input.inspectOnly,
          capabilities,
          reason: packageJson.reason
        }),
        commandPlan: [],
        inspectStatus: "BLOCKED",
        inspectReason: packageJson.reason
      };
    }

    const scripts = scriptsFromPackageJson(packageJson.value);
    const commandPlan = SAFE_COMMAND_CAPABILITIES.map((capability) => nodeScriptForCapability(capability, scripts, packageManager, root)).filter(
      (command): command is SourceCommandDescriptor => Boolean(command)
    );
    const allowed = executionAllowed(input.config, input.inspectOnly);
    const capabilities = nodeCapabilities({ scripts, packageManager, root, executionAllowed: allowed });

    return {
      sourceProject: sourceProjectFromDetection({
        detection: {
          ...input.detection,
          runtime: "node",
          framework: detectNodeFramework(packageJson.value),
          packageManager,
          status: input.detection.status === "LIMITED" ? "LIMITED" : "SUPPORTED",
          capabilities: capabilitiesFromSourceReports(capabilities)
        },
        sourcePath: root,
        inspectOnly: input.inspectOnly || !input.config.safety.allow_source_commands,
        capabilities
      }),
      commandPlan: allowed ? commandPlan : [],
      inspectStatus: "PASS"
    };
  }
}

export class PythonAdapter implements RuntimeAdapter {
  readonly id = "python";
  readonly runtime = "python";
  readonly version = ADAPTER_VERSION;
  readonly support = "SUPPORTED" as const;

  inspect(input: RuntimeAdapterInput): RuntimeAdapterInspection {
    const root = resolve(input.sourcePath);
    const hasPytest = pythonHasPytestConfiguration(root);
    const command = hasPytest
      ? commandDescriptor({
          capability: "test",
          config: {
            executable: pythonExecutable(),
            args: ["-m", "pytest"],
            timeout_seconds: 120
          },
          cwd: root
        })
      : undefined;
    const allowed = executionAllowed(input.config, input.inspectOnly);
    const framework = detectPythonFramework(root);
    const capabilities = pythonCapabilities({
      pytestCommand: command,
      hasPytest,
      executionAllowed: allowed
    });

    return {
      sourceProject: sourceProjectFromDetection({
        detection: {
          ...input.detection,
          runtime: "python",
          framework,
          status: "SUPPORTED",
          capabilities: capabilitiesFromSourceReports(capabilities)
        },
        sourcePath: root,
        inspectOnly: input.inspectOnly || !input.config.safety.allow_source_commands,
        capabilities
      }),
      commandPlan: command && allowed ? [command] : [],
      inspectStatus: "PASS"
    };
  }
}

export class GenericAdapter implements RuntimeAdapter {
  readonly id = "generic";
  readonly runtime = "generic";
  readonly version = ADAPTER_VERSION;
  readonly support = "LIMITED" as const;

  inspect(input: RuntimeAdapterInput): RuntimeAdapterInspection {
    const root = resolve(input.sourcePath);
    const allowed = executionAllowed(input.config, input.inspectOnly);
    const configuredCommands = input.config.source?.commands ?? {};
    const commandPlan = SAFE_COMMAND_CAPABILITIES.map((capability) => {
      const configName = COMMAND_NAME_BY_CAPABILITY[capability];
      const commandConfig = configuredCommands[configName];
      return commandConfig ? commandDescriptor({ capability, config: commandConfig, cwd: root }) : undefined;
    }).filter((command): command is SourceCommandDescriptor => Boolean(command));
    const capabilities = genericCapabilities({ commands: configuredCommands, root, executionAllowed: allowed });

    return {
      sourceProject: sourceProjectFromDetection({
        detection: {
          ...input.detection,
          adapterId: "generic",
          runtime: "generic",
          framework: "explicit-commands",
          status: "LIMITED",
          confidence: Object.keys(configuredCommands).length ? "high" : "medium",
          capabilities: capabilitiesFromSourceReports(capabilities)
        },
        sourcePath: root,
        inspectOnly: input.inspectOnly || !input.config.safety.allow_source_commands,
        capabilities,
        reason: Object.keys(configuredCommands).length ? undefined : "Generic adapter needs explicit source.commands."
      }),
      commandPlan: allowed ? commandPlan : [],
      inspectStatus: "PASS"
    };
  }
}

export class PlannedAdapter implements RuntimeAdapter {
  readonly version = ADAPTER_VERSION;
  readonly support = "PLANNED" as const;

  constructor(
    readonly id: string,
    readonly runtime: string
  ) {}

  inspect(input: RuntimeAdapterInput): RuntimeAdapterInspection {
    const reason = `${this.runtime} runtime is recognized but not executable in S5.`;
    return {
      sourceProject: sourceProjectFromDetection({
        detection: {
          ...input.detection,
          adapterId: this.id,
          runtime: this.runtime,
          framework: "unknown",
          status: "PLANNED",
          reason,
          capabilities: baseCapabilities("NOT_APPLICABLE", reason)
        },
        sourcePath: input.sourcePath,
        inspectOnly: input.inspectOnly,
        capabilities: sourceReportsFromRuntimeCapabilities(baseCapabilities("NOT_APPLICABLE", reason)),
        reason
      }),
      commandPlan: [],
      inspectStatus: "SKIPPED",
      inspectReason: reason
    };
  }
}

async function executeCommandPlan(input: { request: SourceModeRequest; commands: SourceCommandDescriptor[] }): Promise<{
  results: NormalizedResult[];
  sourceCommands: SourceCommandReport[];
  evidence: EvidenceRef[];
}> {
  const runner = new SafeProcessRunner({
    rootDir: input.request.sourcePath,
    redactKeys: input.request.config.report.redact_headers,
    redactValues: collectSecretValues(input.request.config)
  });
  const results: NormalizedResult[] = [];
  const sourceCommands: SourceCommandReport[] = [];
  const evidence: EvidenceRef[] = [];

  for (const command of input.commands) {
    const step = await runner.run(
      {
        executable: command.command,
        args: command.args,
        timeout_seconds: Math.max(1, Math.ceil(command.timeoutMs / 1000))
      },
      { cwd: command.cwd, timeoutMs: command.timeoutMs }
    );
    const mapped = mapCommandStep({ command, step });
    const refs = writeCommandEvidence({
      artifactDir: input.request.artifactDir,
      runId: input.request.runId,
      capability: command.capability,
      stdout: step.stdout,
      stderr: step.stderr
    });

    mapped.stdoutArtifact = refs.stdout?.relativePath;
    mapped.stderrArtifact = refs.stderr?.relativePath;
    sourceCommands.push(mapped);
    evidence.push(...[refs.stdout, refs.stderr].filter((item): item is EvidenceRef => Boolean(item)));
    results.push(
      sourceResult({
        request: input.request,
        testKey: `source.${command.capability}`,
        title: `Run source ${command.capability} command`,
        status: mapped.status,
        startedAt: step.startedAt,
        durationMs: step.durationMs,
        targetRef: input.request.sourcePath,
        expected: {
          command: command.command,
          args: command.args,
          cwd: displayPath(command.cwd)
        },
        actual: {
          exitCode: mapped.exitCode,
          stdoutArtifact: mapped.stdoutArtifact,
          stderrArtifact: mapped.stderrArtifact,
          reason: mapped.reason
        },
        error: mapped.status === "PASS" || mapped.status === "SKIPPED" ? undefined : mapped.reason ?? shortError(step.stderr),
        evidenceRefs: [refs.stdout, refs.stderr].filter((item): item is EvidenceRef => Boolean(item))
      })
    );
  }

  return { results, sourceCommands, evidence };
}

function mapCommandStep(input: { command: SourceCommandDescriptor; step: StepResult }): SourceCommandReport {
  const reason = commandReason(input.step);
  const status = commandStatus(input.step, reason);
  return {
    capability: input.command.capability,
    command: input.command.command,
    args: input.command.args,
    cwd: input.command.cwd,
    exitCode: input.step.exitCode,
    durationMs: input.step.durationMs,
    status,
    startedAt: input.step.startedAt,
    reason
  };
}

function commandStatus(step: StepResult, reason?: string): ResultStatus {
  if (reason === "COMMAND_NOT_FOUND" || reason === "PYTEST_UNAVAILABLE") {
    return "BLOCKED";
  }
  return step.status;
}

function commandReason(step: StepResult): string | undefined {
  const stderr = step.stderr ?? "";
  if (stderr.includes("COMMAND_TIMEOUT")) {
    return "COMMAND_TIMEOUT";
  }
  if (/ENOENT|not found|not recognized as an internal or external command/i.test(stderr)) {
    return "COMMAND_NOT_FOUND";
  }
  if (/No module named pytest|ModuleNotFoundError: No module named ['"]pytest['"]/i.test(stderr)) {
    return "PYTEST_UNAVAILABLE";
  }
  if (step.status === "FAIL") {
    return "COMMAND_EXIT_NONZERO";
  }
  if (step.status === "ERROR") {
    return "COMMAND_ERROR";
  }
  return undefined;
}

function writeCommandEvidence(input: {
  artifactDir: string;
  runId: string;
  capability: SourceCapabilityName;
  stdout?: string;
  stderr?: string;
}): { stdout?: EvidenceRef; stderr?: EvidenceRef } {
  const refs: { stdout?: EvidenceRef; stderr?: EvidenceRef } = {};

  if (input.stdout) {
    refs.stdout = writeLogEvidence({
      artifactDir: input.artifactDir,
      runId: input.runId,
      relativePath: join("source", safeFilePart(input.capability), "stdout.log"),
      content: input.stdout
    });
  }

  if (input.stderr) {
    refs.stderr = writeLogEvidence({
      artifactDir: input.artifactDir,
      runId: input.runId,
      relativePath: join("source", safeFilePart(input.capability), "stderr.log"),
      content: input.stderr
    });
  }

  return refs;
}

function writeLogEvidence(input: { artifactDir: string; runId: string; relativePath: string; content: string }): EvidenceRef {
  const absolutePath = join(input.artifactDir, input.relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, input.content, "utf8");
  const buffer = readFileSync(absolutePath);
  return {
    id: stableId(input.runId, input.relativePath),
    type: "log",
    relativePath: input.relativePath,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    size: buffer.byteLength
  };
}

function nodeCapabilities(input: {
  scripts: Record<string, string>;
  packageManager: string;
  root: string;
  executionAllowed: boolean;
}): SourceCapabilityReport[] {
  return SOURCE_CAPABILITIES.map((name) => {
    if (name === "detect" || name === "inspect") {
      return { name, state: "SUPPORTED" };
    }
    if (!isSafeCommandCapability(name)) {
      return { name, state: name === "install" ? "DISABLED" : "NOT_APPLICABLE", reason: reasonForNonCheckCapability(name) };
    }
    const scriptName = COMMAND_NAME_BY_CAPABILITY[name];
    if (!input.scripts[scriptName]) {
      return { name, state: "UNAVAILABLE", reason: `package.json script '${scriptName}' is not defined.` };
    }
    const command = nodeScriptForCapability(name, input.scripts, input.packageManager, input.root);
    return {
      name,
      state: input.executionAllowed ? "SUPPORTED" : "DISABLED",
      reason: input.executionAllowed ? undefined : "Source command execution is disabled by safety policy or --inspect-only.",
      command
    };
  });
}

function pythonCapabilities(input: {
  pytestCommand?: SourceCommandDescriptor;
  hasPytest: boolean;
  executionAllowed: boolean;
}): SourceCapabilityReport[] {
  return SOURCE_CAPABILITIES.map((name) => {
    if (name === "detect" || name === "inspect") {
      return { name, state: "SUPPORTED" };
    }
    if (name === "test") {
      if (!input.hasPytest || !input.pytestCommand) {
        return { name, state: "UNAVAILABLE", reason: "pytest was not configured or discoverable." };
      }
      return {
        name,
        state: input.executionAllowed ? "SUPPORTED" : "DISABLED",
        reason: input.executionAllowed ? undefined : "Source command execution is disabled by safety policy or --inspect-only.",
        command: input.pytestCommand
      };
    }
    return { name, state: name === "install" ? "DISABLED" : "NOT_APPLICABLE", reason: reasonForNonCheckCapability(name) };
  });
}

function genericCapabilities(input: {
  commands: NonNullable<QAgentConfig["source"]>["commands"];
  root: string;
  executionAllowed: boolean;
}): SourceCapabilityReport[] {
  const commands = input.commands ?? {};
  return SOURCE_CAPABILITIES.map((name) => {
    if (name === "detect" || name === "inspect") {
      return { name, state: "SUPPORTED" };
    }
    if (!isSafeCommandCapability(name)) {
      return {
        name,
        state: commands[sourceCommandNameForCapability(name)] ? "DISABLED" : "NOT_APPLICABLE",
        reason: reasonForNonCheckCapability(name)
      };
    }
    const commandConfig = commands[COMMAND_NAME_BY_CAPABILITY[name]];
    if (!commandConfig) {
      return { name, state: "UNAVAILABLE", reason: `source.commands.${COMMAND_NAME_BY_CAPABILITY[name]} is not configured.` };
    }
    return {
      name,
      state: input.executionAllowed ? "SUPPORTED" : "DISABLED",
      reason: input.executionAllowed ? undefined : "Source command execution is disabled by safety policy or --inspect-only.",
      command: commandDescriptor({ capability: name, config: commandConfig, cwd: input.root })
    };
  });
}

function baseCapabilities(state: CapabilityState, reason?: string): RuntimeCapability[] {
  return SOURCE_CAPABILITIES.map((name) => ({
    name,
    supported: state === "SUPPORTED",
    state,
    reason
  }));
}

function sourceReportsFromRuntimeCapabilities(capabilities: RuntimeCapability[] | SourceCapabilityReport[]): SourceCapabilityReport[] {
  return SOURCE_CAPABILITIES.map((name) => {
    const capability = capabilities.find((item) => item.name === name);
    return {
      name,
      state: capability?.state ?? ("supported" in (capability ?? {}) && capability?.supported ? "SUPPORTED" : "UNAVAILABLE"),
      reason: capability?.reason,
      command: capability?.command
    };
  });
}

function capabilitiesFromSourceReports(capabilities: SourceCapabilityReport[]): RuntimeCapability[] {
  return capabilities.map((capability) => ({
    name: capability.name,
    supported: capability.state === "SUPPORTED",
    state: capability.state,
    reason: capability.reason,
    command: capability.command
  }));
}

function sourceProjectFromDetection(input: {
  detection: DetectionResult;
  sourcePath: string;
  inspectOnly: boolean;
  capabilities: SourceCapabilityReport[] | RuntimeCapability[];
  reason?: string;
}): SourceProjectReport {
  const capabilities = sourceReportsFromRuntimeCapabilities(input.capabilities);
  return {
    path: resolve(input.sourcePath),
    runtime: input.detection.runtime ?? input.detection.adapterId,
    framework: input.detection.framework ?? "unknown",
    confidence: input.detection.confidence,
    packageManager: input.detection.packageManager,
    markers: [...(input.detection.markers ?? input.detection.manifests)].sort(markerSort),
    adapterId: input.detection.adapterId,
    support: input.detection.status,
    capabilities,
    inspectOnly: input.inspectOnly,
    reason: input.reason ?? input.detection.reason
  };
}

function detection(input: {
  adapterId: string;
  runtime: string;
  framework?: string;
  packageManager?: string;
  status: RuntimeSupportState;
  confidence: DetectionResult["confidence"];
  markers: string[];
  capabilities: RuntimeCapability[];
  reason?: string;
}): DetectionResult {
  const markers = [...input.markers].sort(markerSort);
  return {
    adapterId: input.adapterId,
    runtime: input.runtime,
    framework: input.framework ?? "unknown",
    packageManager: input.packageManager,
    confidence: input.confidence,
    status: input.status,
    manifests: markers,
    markers,
    capabilities: input.capabilities,
    reason: input.reason
  };
}

function explicitDetection(adapterId: string, root: string, markers: string[], hasExplicitCommands: boolean): DetectionResult {
  const markerSet = new Set(markers);
  if (adapterId === "node") {
    const packageJson = readPackageJson(root);
    const hasPackageJson = markerSet.has("package.json");
    const reason = hasPackageJson && !packageJson.ok ? packageJson.reason : hasPackageJson ? undefined : "Node adapter was explicitly selected without package.json.";
    return detection({
      adapterId,
      runtime: "node",
      framework: packageJson.ok ? detectNodeFramework(packageJson.value) : "unknown",
      packageManager: detectPackageManager(markerSet),
      status: hasPackageJson ? "SUPPORTED" : "LIMITED",
      confidence: hasPackageJson ? "high" : "low",
      markers,
      reason,
      capabilities: baseCapabilities("UNAVAILABLE")
    });
  }
  if (adapterId === "python") {
    const hasPythonMarkers = hasAny(markerSet, ["pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock"]);
    return detection({
      adapterId,
      runtime: "python",
      framework: detectPythonFramework(root),
      status: hasPythonMarkers ? "SUPPORTED" : "LIMITED",
      confidence: hasPythonMarkers ? "high" : "low",
      markers,
      reason: hasPythonMarkers ? undefined : "Python adapter was explicitly selected without Python markers.",
      capabilities: baseCapabilities("UNAVAILABLE")
    });
  }
  if (adapterId === "generic") {
    return detection({
      adapterId,
      runtime: "generic",
      framework: "explicit-commands",
      status: "LIMITED",
      confidence: hasExplicitCommands ? "high" : "medium",
      markers,
      reason: hasExplicitCommands ? undefined : "Generic adapter was explicitly selected without source.commands.",
      capabilities: baseCapabilities("UNAVAILABLE")
    });
  }
  if (["php", "java", "dotnet", "go"].includes(adapterId)) {
    return detection({
      adapterId,
      runtime: adapterId,
      framework: "unknown",
      status: "PLANNED",
      confidence: "medium",
      markers,
      reason: `${adapterId} adapter is planned but not executable in S5.`,
      capabilities: baseCapabilities("NOT_APPLICABLE")
    });
  }
  return detection({
    adapterId,
    runtime: adapterId,
    framework: "unknown",
    status: "UNSUPPORTED",
    confidence: "low",
    markers,
    reason: `Configured source adapter '${adapterId}' is not supported.`,
    capabilities: baseCapabilities("UNAVAILABLE")
  });
}

function detectMarkers(root: string): string[] {
  const entries = safeRootEntries(root);
  const entrySet = new Set(entries);
  const markers: string[] = [];
  for (const marker of MARKER_ORDER) {
    if (entrySet.has(marker)) {
      markers.push(marker);
    }
  }
  for (const entry of entries) {
    if (entry.endsWith(".sln") || entry.endsWith(".csproj")) {
      markers.push(entry);
    }
  }
  return [...new Set(markers)].sort(markerSort);
}

function safeRootEntries(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() || !IGNORED_DIRECTORIES.has(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function readPackageJson(root: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const path = join(root, "package.json");
  if (!existsSync(path)) {
    return { ok: false, reason: "package.json is missing." };
  }
  try {
    return { ok: true, value: JSON.parse(boundedRead(path)) };
  } catch (error) {
    return {
      ok: false,
      reason: `MALFORMED_PACKAGE_JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function scriptsFromPackageJson(packageJson: unknown): Record<string, string> {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return {};
  }
  const scripts = (packageJson as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return {};
  }
  return Object.fromEntries(Object.entries(scripts).filter(([, value]) => typeof value === "string")) as Record<string, string>;
}

function detectNodeFramework(packageJson: unknown): string {
  const names = packageJsonNames(packageJson);
  if (names.has("next")) {
    return "nextjs";
  }
  if (names.has("vite")) {
    return "vite";
  }
  if (names.has("@nestjs/core")) {
    return "nestjs";
  }
  if (names.has("vue")) {
    return "vue";
  }
  if (names.has("react")) {
    return "react";
  }
  if (names.has("express")) {
    return "express";
  }
  return "unknown";
}

function packageJsonNames(packageJson: unknown): Set<string> {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return new Set();
  }
  const value = packageJson as Record<string, unknown>;
  return new Set(
    ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
      .flatMap((key) => objectKeys(value[key]))
      .map((name) => name.toLowerCase())
  );
}

function objectKeys(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  return Object.keys(input);
}

function detectPackageManager(markers: Set<string>): string {
  if (markers.has("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (markers.has("yarn.lock")) {
    return "yarn";
  }
  return "npm";
}

function nodeScriptForCapability(
  capability: (typeof SAFE_COMMAND_CAPABILITIES)[number],
  scripts: Record<string, string>,
  packageManager: string,
  cwd: string
): SourceCommandDescriptor | undefined {
  const scriptName = COMMAND_NAME_BY_CAPABILITY[capability];
  if (!scripts[scriptName]) {
    return undefined;
  }
  return commandDescriptor({
    capability,
    config: packageManagerCommand(packageManager, scriptName),
    cwd
  });
}

function packageManagerCommand(packageManager: string, scriptName: string): SourceCommandConfig {
  const cliPath = packageManagerCliPath(packageManager);
  if (cliPath) {
    return { executable: process.execPath, args: [cliPath, "run", scriptName], timeout_seconds: 120 };
  }
  if (packageManager === "pnpm") {
    return { executable: "pnpm", args: ["run", scriptName], timeout_seconds: 120 };
  }
  if (packageManager === "yarn") {
    return { executable: "yarn", args: ["run", scriptName], timeout_seconds: 120 };
  }
  return { executable: "npm", args: ["run", scriptName], timeout_seconds: 120 };
}

function packageManagerCliPath(packageManager: string): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  const nodeRoot = dirname(process.execPath);
  const candidates =
    packageManager === "npm"
      ? [join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js")]
      : [join(nodeRoot, "node_modules", "corepack", "dist", `${packageManager}.js`)];
  return candidates.find((candidate) => existsSync(candidate));
}

function detectPythonFramework(root: string): string {
  const pyproject = existsSync(join(root, "pyproject.toml")) ? boundedRead(join(root, "pyproject.toml")).toLowerCase() : "";
  const requirements = existsSync(join(root, "requirements.txt")) ? boundedRead(join(root, "requirements.txt")).toLowerCase() : "";
  const text = `${pyproject}\n${requirements}`;
  if (/\bdjango\b/.test(text)) {
    return "django";
  }
  if (/\bfastapi\b/.test(text)) {
    return "fastapi";
  }
  if (/\bflask\b/.test(text)) {
    return "flask";
  }
  return "unknown";
}

function pythonHasPytestConfiguration(root: string): boolean {
  if (existsSync(join(root, "pytest.ini"))) {
    return true;
  }
  const pyproject = existsSync(join(root, "pyproject.toml")) ? boundedRead(join(root, "pyproject.toml")).toLowerCase() : "";
  if (pyproject.includes("[tool.pytest")) {
    return true;
  }
  for (const file of ["setup.cfg", "tox.ini"]) {
    const path = join(root, file);
    if (existsSync(path) && boundedRead(path).toLowerCase().includes("[pytest]")) {
      return true;
    }
  }
  const testsDir = join(root, "tests");
  try {
    return statSync(testsDir).isDirectory() && readdirSync(testsDir).some((file) => /^test_.*\.py$/i.test(file));
  } catch {
    return false;
  }
}

function boundedRead(path: string): string {
  const buffer = readFileSync(path);
  return buffer.subarray(0, 256 * 1024).toString("utf8");
}

function pythonExecutable(): string {
  return process.platform === "win32" ? "python" : "python3";
}

function plannedRuntime(markers: Set<string>): string | undefined {
  if (markers.has("composer.json")) {
    return "php";
  }
  if (hasAny(markers, ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"])) {
    return "java";
  }
  if ([...markers].some((marker) => marker.endsWith(".sln") || marker.endsWith(".csproj")) || markers.has("global.json")) {
    return "dotnet";
  }
  if (markers.has("go.mod")) {
    return "go";
  }
  return undefined;
}

function commandDescriptor(input: {
  capability: SourceCapabilityName;
  config: SourceCommandConfig;
  cwd: string;
}): SourceCommandDescriptor {
  return {
    capability: input.capability,
    command: input.config.executable,
    args: input.config.args ?? [],
    cwd: resolve(input.cwd),
    timeoutMs: Math.max(1, input.config.timeout_seconds ?? 60) * 1000
  };
}

function hasAny(markers: Set<string>, names: string[]): boolean {
  return names.some((name) => markers.has(name));
}

function normalizeAdapterId(input?: string): string | undefined {
  return input?.trim().toLowerCase();
}

function isExecutableSupport(support: RuntimeSupportState): boolean {
  return support === "SUPPORTED" || support === "LIMITED";
}

function executionAllowed(config: QAgentConfig, inspectOnly: boolean): boolean {
  return config.safety.allow_source_commands && !inspectOnly;
}

function isSafeCommandCapability(name: SourceCapabilityName): name is (typeof SAFE_COMMAND_CAPABILITIES)[number] {
  return (SAFE_COMMAND_CAPABILITIES as readonly SourceCapabilityName[]).includes(name);
}

function sourceCommandNameForCapability(name: SourceCapabilityName): SourceCommandName {
  if (name === "typeCheck") {
    return "typecheck";
  }
  if (name === "healthCheck" || name === "stop") {
    return "start";
  }
  return name as SourceCommandName;
}

function reasonForNonCheckCapability(name: SourceCapabilityName): string {
  if (name === "install") {
    return "Install is disabled in S5 because it mutates the source tree.";
  }
  if (name === "start" || name === "healthCheck" || name === "stop") {
    return "Long-running runtime lifecycle commands are not executed in S5.";
  }
  return "Capability is not applicable for this runtime adapter.";
}

function summarizeDetection(result: DetectionResult): Record<string, unknown> {
  return {
    runtime: result.runtime,
    framework: result.framework,
    adapterId: result.adapterId,
    support: result.status,
    confidence: result.confidence,
    packageManager: result.packageManager,
    markers: result.markers ?? result.manifests,
    reason: result.reason
  };
}

function sourceResult(input: {
  request: SourceModeRequest;
  testKey: string;
  title: string;
  status: ResultStatus;
  targetRef: string;
  expected: unknown;
  actual: unknown;
  startedAt?: string;
  durationMs?: number;
  error?: string;
  evidenceRefs?: EvidenceRef[];
}): NormalizedResult {
  return {
    id: randomUUID(),
    runId: input.request.runId,
    testKey: input.testKey,
    layer: "source",
    title: input.title,
    status: input.status,
    startedAt: input.startedAt ?? new Date().toISOString(),
    durationMs: input.durationMs ?? 0,
    targetRef: input.targetRef,
    error: input.error ? sanitize(input.error, input.request.config) : undefined,
    expected: input.expected,
    actual: input.actual,
    evidenceRefs: input.evidenceRefs ?? [],
    findingRefs: [],
    adapterId: "runtime-source",
    adapterVersion: ADAPTER_VERSION
  };
}

function sanitize(input: string, config: QAgentConfig): string {
  return redactText(input, config.report.redact_headers);
}

function shortError(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }
  return input.trim().slice(0, 500) || undefined;
}

function collectSecretValues(config: QAgentConfig): string[] {
  const values = new Set<string>();
  for (const profile of Object.values(config.auth.profiles)) {
    for (const raw of [profile.credentials.username, profile.credentials.password]) {
      if (raw && !raw.startsWith("${")) {
        values.add(raw);
      }
      const envName = /^\$\{([A-Z0-9_]+)\}$/i.exec(raw)?.[1];
      if (envName && process.env[envName]) {
        values.add(process.env[envName] as string);
      }
    }
  }
  return [...values].filter((value) => value.length >= 3);
}

function displayPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function safeFilePart(input: string): string {
  return input.replace(/[^a-z0-9_.-]/gi, "_").toLowerCase();
}

function markerSort(left: string, right: string): number {
  const leftIndex = MARKER_ORDER.indexOf(left as (typeof MARKER_ORDER)[number]);
  const rightIndex = MARKER_ORDER.indexOf(right as (typeof MARKER_ORDER)[number]);
  if (leftIndex >= 0 && rightIndex >= 0) {
    return leftIndex - rightIndex;
  }
  if (leftIndex >= 0) {
    return -1;
  }
  if (rightIndex >= 0) {
    return 1;
  }
  return left.localeCompare(right);
}

function stableId(runId: string, relativePath: string): string {
  return `evidence_${createHash("sha256").update(`${runId}:${relativePath}`).digest("hex").slice(0, 16)}`;
}

function adapterSummaryCapabilities(adapter: RuntimeAdapter): SourceCapabilityName[] {
  if (adapter.id === "node") {
    return ["detect", "inspect", "lint", "typeCheck", "test", "build"];
  }
  if (adapter.id === "python") {
    return ["detect", "inspect", "test"];
  }
  if (adapter.id === "generic") {
    return ["detect", "inspect", "lint", "typeCheck", "test", "build"];
  }
  return ["detect"];
}
