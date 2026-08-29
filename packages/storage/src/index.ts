import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApiEndpoint,
  AuthProfileReport,
  BaselineRecord,
  BrowserTestMetadata,
  DiscoveredPage,
  EvidenceRef,
  Finding,
  NormalizedResult,
  ProjectRecord,
  QualityGateSummary,
  RegressionComparison,
  RunRecord,
  RunReportData,
  RunStatus,
  SourceCommandReport,
  SourceProjectReport,
  TargetEnvironment,
  TargetMode,
  TargetRecord
} from "#contracts";
import type { RunStore } from "#core";

interface ProjectRow {
  id: string;
  name: string;
  settings_ref: string | null;
  created_at: string;
}

interface TargetRow {
  id: string;
  project_id: string;
  mode: TargetMode;
  url: string | null;
  source_path: string | null;
  environment: TargetEnvironment;
  allowed_hosts_json: string;
  created_at: string;
}

interface RunRow {
  id: string;
  project_id: string;
  target_id: string;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  tool_versions_json: string;
  summary_json: string | null;
  artifact_dir: string;
  created_at: string;
  updated_at: string;
}

interface ResultRow {
  id: string;
  run_id: string;
  test_key: string;
  layer: NormalizedResult["layer"];
  title: string;
  status: NormalizedResult["status"];
  started_at: string;
  duration_ms: number;
  target_ref: string;
  role_profile: string | null;
  priority: NormalizedResult["priority"] | null;
  tags_json: string | null;
  dependencies_json: string | null;
  error_text: string | null;
  expected_json: string | null;
  actual_json: string | null;
  evidence_refs_json: string;
  finding_refs_json: string;
  adapter_id: string;
  adapter_version: string;
}

interface DiscoveredPageRow {
  id: string;
  run_id: string;
  url: string;
  normalized_url: string;
  final_url: string | null;
  status_code: number | null;
  title: string | null;
  link_count: number;
  form_count: number;
  button_count: number;
  redirect_count: number;
  console_errors_json: string;
  network_errors_json: string;
  discovered_at: string;
}

interface ApiEndpointRow {
  id: string;
  run_id: string;
  method: string;
  normalized_path: string;
  status_codes_json: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

interface FindingRow {
  id: string;
  run_id: string;
  fingerprint: string;
  category: string;
  severity: Finding["severity"];
  title: string;
  description: string;
  url: string | null;
  method: string | null;
  endpoint: string | null;
  role_profile: string | null;
  remediation_hint: string | null;
  details_json: string | null;
  evidence_refs_json: string;
  redaction_applied: number;
}

interface EvidenceRow {
  id: string;
  run_id: string;
  type: EvidenceRef["type"];
  relative_path: string;
  sha256: string | null;
  size: number | null;
}

interface AuthProfileRow {
  run_id: string;
  name: string;
  login_url: string;
  username_ref: string;
  success_json: string;
  session_artifact: string | null;
}

interface RegisteredTestRow {
  run_id: string;
  key: string;
  title: string;
  layer: BrowserTestMetadata["layer"];
  tags_json: string;
  priority: BrowserTestMetadata["priority"];
  profile: string | null;
  timeout_ms: number;
  dependencies_json: string;
}

interface SourceProjectRow {
  run_id: string;
  path: string;
  runtime: string;
  framework: string;
  confidence: SourceProjectReport["confidence"];
  runtime_version: string | null;
  package_manager: string | null;
  markers_json: string;
  adapter_id: string;
  support: SourceProjectReport["support"];
  capabilities_json: string;
  inspect_only: number;
  reason: string | null;
}

interface SourceCommandRow {
  run_id: string;
  capability: SourceCommandReport["capability"];
  command: string;
  args_json: string;
  cwd: string;
  exit_code: number | null;
  duration_ms: number;
  status: SourceCommandReport["status"];
  started_at: string;
  stdout_artifact: string | null;
  stderr_artifact: string | null;
  reason: string | null;
}

interface BaselineRow {
  id: string;
  project_id: string;
  run_id: string;
  name: string;
  created_at: string;
}

interface ComparisonRow {
  id: string;
  project_id: string;
  baseline_id: string;
  baseline_run_id: string;
  current_run_id: string;
  summary_json: string;
  entries_json: string;
  finding_entries_json: string | null;
  created_at: string;
}

export class RegressionStorageError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "RegressionStorageError";
    this.issues = issues;
  }
}

export class SqliteRunStore implements RunStore {
  private db?: DatabaseSync;

  constructor(private readonly dbPath: string) {}

  initialize(): void {
    if (!this.db) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA journal_mode = WAL;");
    }

    this.db.exec(SCHEMA_SQL);
    ensureColumn(this.database, "discovered_pages", "final_url", "TEXT");
    ensureColumn(this.database, "discovered_pages", "button_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.database, "discovered_pages", "redirect_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.database, "test_results", "priority", "TEXT");
    ensureColumn(this.database, "test_results", "tags_json", "TEXT");
    ensureColumn(this.database, "test_results", "dependencies_json", "TEXT");
    ensureColumn(this.database, "test_results", "error_text", "TEXT");
    ensureColumn(this.database, "findings", "details_json", "TEXT");
    ensureColumn(this.database, "comparisons", "finding_entries_json", "TEXT");
  }

  createBaseline(input: { runId: string; name: string; createdAt?: string; force?: boolean }): BaselineRecord {
    const name = input.name.trim();
    if (!name) {
      throw new RegressionStorageError("Unable to create baseline.", ["baseline name is required"]);
    }

    const run = this.getRun(input.runId);
    if (run.status !== "COMPLETED") {
      throw new RegressionStorageError("Unable to create baseline.", [`run ${input.runId} is not completed`]);
    }

    const existing = this.database.prepare("SELECT * FROM baselines WHERE project_id = ? AND name = ?").get(run.projectId, name) as BaselineRow | undefined;
    if (existing && existing.run_id !== input.runId && !input.force) {
      throw new RegressionStorageError("Unable to create baseline.", [
        `baseline '${name}' already references run ${existing.run_id}; pass --force to replace it`
      ]);
    }
    if (existing && existing.run_id === input.runId) {
      return baselineFromRow(existing);
    }

    const baselineId = existing?.id ?? stableStorageId("baseline", [run.projectId, name]);
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO baselines (id, project_id, run_id, name, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, name) DO UPDATE SET
           run_id = excluded.run_id,
           created_at = excluded.created_at`
      )
      .run(baselineId, run.projectId, input.runId, name, createdAt);

    return this.getBaselineById(baselineId);
  }

  resolveBaselineForRun(input: { runId: string; baseline: string }): BaselineRecord {
    const run = this.getRun(input.runId);
    const byId = this.findBaselineById(input.baseline);
    if (byId) {
      if (byId.projectId !== run.projectId) {
        throw new RegressionStorageError("Unable to resolve baseline.", [`baseline '${input.baseline}' belongs to a different project`]);
      }
      return byId;
    }

    const row = this.database.prepare("SELECT * FROM baselines WHERE project_id = ? AND name = ?").get(run.projectId, input.baseline) as BaselineRow | undefined;
    if (!row) {
      throw new RegressionStorageError("Unable to resolve baseline.", [`baseline '${input.baseline}' was not found for project ${run.projectId}`]);
    }
    return baselineFromRow(row);
  }

  addComparison(comparison: RegressionComparison): RegressionComparison {
    this.database
      .prepare(
        `INSERT INTO comparisons
          (id, project_id, baseline_id, baseline_run_id, current_run_id, summary_json, entries_json, finding_entries_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary_json = excluded.summary_json,
           entries_json = excluded.entries_json,
           finding_entries_json = excluded.finding_entries_json,
           created_at = excluded.created_at`
      )
      .run(
        comparison.id,
        comparison.project.id,
        comparison.baseline.id,
        comparison.baselineRun.id,
        comparison.currentRun.id,
        JSON.stringify(comparison.summary),
        JSON.stringify(comparison.entries),
        JSON.stringify(comparison.findingEntries),
        comparison.comparedAt
      );
    return comparison;
  }

  getComparison(comparisonId: string): RegressionComparison {
    const row = this.database.prepare("SELECT * FROM comparisons WHERE id = ?").get(comparisonId) as ComparisonRow | undefined;
    if (!row) {
      throw new RegressionStorageError("Comparison not found.", [`comparison '${comparisonId}' was not found`]);
    }
    return {
      id: row.id,
      project: this.getProject(row.project_id),
      baseline: this.getBaselineById(row.baseline_id),
      baselineRun: this.getRun(row.baseline_run_id),
      currentRun: this.getRun(row.current_run_id),
      comparedAt: row.created_at,
      summary: JSON.parse(row.summary_json) as RegressionComparison["summary"],
      entries: JSON.parse(row.entries_json) as RegressionComparison["entries"],
      findingEntries: row.finding_entries_json ? (JSON.parse(row.finding_entries_json) as RegressionComparison["findingEntries"]) : []
    };
  }

  upsertProject(input: { id: string; name: string; settingsRef?: string; createdAt: string }): ProjectRecord {
    this.database
      .prepare(
        `INSERT INTO projects (id, name, settings_ref, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           settings_ref = excluded.settings_ref`
      )
      .run(input.id, input.name, input.settingsRef ?? null, input.createdAt);

    return this.getProject(input.id);
  }

  upsertTarget(input: {
    id: string;
    projectId: string;
    mode: TargetMode;
    url?: string;
    sourcePath?: string;
    environment: TargetEnvironment;
    allowedHosts: string[];
    createdAt: string;
  }): TargetRecord {
    this.database
      .prepare(
        `INSERT INTO targets (id, project_id, mode, url, source_path, environment, allowed_hosts_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           url = excluded.url,
           source_path = excluded.source_path,
           environment = excluded.environment,
           allowed_hosts_json = excluded.allowed_hosts_json`
      )
      .run(
        input.id,
        input.projectId,
        input.mode,
        input.url ?? null,
        input.sourcePath ?? null,
        input.environment,
        JSON.stringify(input.allowedHosts),
        input.createdAt
      );

    return this.getTarget(input.id);
  }

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
  }): RunRecord {
    this.database
      .prepare(
        `INSERT INTO test_runs
          (id, project_id, target_id, status, started_at, completed_at, tool_versions_json, summary_json, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`
      )
      .run(
        input.id,
        input.projectId,
        input.targetId,
        input.status,
        input.startedAt,
        JSON.stringify(input.toolVersions),
        input.artifactDir,
        input.createdAt,
        input.updatedAt
      );

    return this.getRun(input.id);
  }

  updateRunStatus(runId: string, status: RunStatus, fields: { completedAt?: string; summary?: QualityGateSummary } = {}): void {
    this.database
      .prepare(
        `UPDATE test_runs
         SET status = ?, completed_at = COALESCE(?, completed_at), summary_json = COALESCE(?, summary_json), updated_at = ?
         WHERE id = ?`
      )
      .run(status, fields.completedAt ?? null, fields.summary ? JSON.stringify(fields.summary) : null, new Date().toISOString(), runId);
  }

  addResult(result: NormalizedResult): void {
    this.database
      .prepare(
        `INSERT INTO test_results
          (id, run_id, test_key, layer, title, status, started_at, duration_ms, target_ref, role_profile,
           priority, tags_json, dependencies_json, error_text, expected_json, actual_json, evidence_refs_json, finding_refs_json, adapter_id, adapter_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.id,
        result.runId,
        result.testKey,
        result.layer,
        result.title,
        result.status,
        result.startedAt,
        result.durationMs,
        result.targetRef,
        result.roleProfile ?? null,
        result.priority ?? null,
        result.tags ? JSON.stringify(result.tags) : null,
        result.dependencies ? JSON.stringify(result.dependencies) : null,
        result.error ?? null,
        result.expected === undefined ? null : JSON.stringify(result.expected),
        result.actual === undefined ? null : JSON.stringify(result.actual),
        JSON.stringify(result.evidenceRefs),
        JSON.stringify(result.findingRefs),
        result.adapterId,
        result.adapterVersion
      );
  }

  addDiscoveredPages(pages: DiscoveredPage[]): void {
    const statement = this.database.prepare(
      `INSERT INTO discovered_pages
        (id, run_id, url, normalized_url, final_url, status_code, title, link_count, form_count, button_count, redirect_count, console_errors_json, network_errors_json, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         final_url = excluded.final_url,
         status_code = excluded.status_code,
         title = excluded.title,
         link_count = excluded.link_count,
         form_count = excluded.form_count,
         button_count = excluded.button_count,
         redirect_count = excluded.redirect_count,
         console_errors_json = excluded.console_errors_json,
         network_errors_json = excluded.network_errors_json`
    );

    for (const page of pages) {
      statement.run(
        page.id,
        page.runId,
        page.url,
        page.normalizedUrl,
        page.finalUrl ?? null,
        page.statusCode ?? null,
        page.title ?? null,
        page.linkCount,
        page.formCount,
        page.buttonCount,
        page.redirectCount,
        JSON.stringify(page.consoleErrors),
        JSON.stringify(page.networkErrors),
        page.discoveredAt
      );
    }
  }

  addApiEndpoints(endpoints: ApiEndpoint[]): void {
    const statement = this.database.prepare(
      `INSERT INTO api_endpoints
        (id, run_id, method, normalized_path, status_codes_json, count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status_codes_json = excluded.status_codes_json,
         count = excluded.count,
         last_seen_at = excluded.last_seen_at`
    );

    for (const endpoint of endpoints) {
      statement.run(
        endpoint.id,
        endpoint.runId,
        endpoint.method,
        endpoint.normalizedPath,
        JSON.stringify(endpoint.statusCodes),
        endpoint.count,
        endpoint.firstSeenAt,
        endpoint.lastSeenAt
      );
    }
  }

  addFindings(runId: string, findings: Finding[]): void {
    const statement = this.database.prepare(
      `INSERT INTO findings
        (id, run_id, fingerprint, category, severity, title, description, url, method, endpoint, role_profile, remediation_hint, details_json, evidence_refs_json, redaction_applied)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         severity = excluded.severity,
         description = excluded.description,
         details_json = excluded.details_json,
         evidence_refs_json = excluded.evidence_refs_json,
         redaction_applied = excluded.redaction_applied`
    );

    for (const finding of findings) {
      statement.run(
        finding.id,
        runId,
        finding.fingerprint,
        finding.category,
        finding.severity,
        finding.title,
        finding.description,
        finding.url ?? null,
        finding.method ?? null,
        finding.endpoint ?? null,
        finding.roleProfile ?? null,
        finding.remediationHint ?? null,
        finding.details ? JSON.stringify(finding.details) : null,
        JSON.stringify(finding.evidenceRefs),
        finding.redactionApplied ? 1 : 0
      );
    }
  }

  addEvidence(runId: string, evidence: EvidenceRef[]): void {
    const statement = this.database.prepare(
      `INSERT INTO evidence (id, run_id, type, relative_path, sha256, size)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size`
    );

    for (const item of evidence) {
      statement.run(item.id, runId, item.type, item.relativePath, item.sha256 ?? null, item.size ?? null);
    }
  }

  addSourceProject(runId: string, sourceProject?: SourceProjectReport): void {
    if (!sourceProject) {
      return;
    }

    this.database
      .prepare(
        `INSERT INTO source_projects
          (run_id, path, runtime, framework, confidence, runtime_version, package_manager, markers_json, adapter_id, support, capabilities_json, inspect_only, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           path = excluded.path,
           runtime = excluded.runtime,
           framework = excluded.framework,
           confidence = excluded.confidence,
           runtime_version = excluded.runtime_version,
           package_manager = excluded.package_manager,
           markers_json = excluded.markers_json,
           adapter_id = excluded.adapter_id,
           support = excluded.support,
           capabilities_json = excluded.capabilities_json,
           inspect_only = excluded.inspect_only,
           reason = excluded.reason`
      )
      .run(
        runId,
        sourceProject.path,
        sourceProject.runtime,
        sourceProject.framework,
        sourceProject.confidence,
        sourceProject.runtimeVersion ?? null,
        sourceProject.packageManager ?? null,
        JSON.stringify(sourceProject.markers),
        sourceProject.adapterId,
        sourceProject.support,
        JSON.stringify(sourceProject.capabilities),
        sourceProject.inspectOnly ? 1 : 0,
        sourceProject.reason ?? null
      );
  }

  addSourceCommands(runId: string, commands: SourceCommandReport[]): void {
    const statement = this.database.prepare(
      `INSERT INTO source_commands
        (run_id, capability, command, args_json, cwd, exit_code, duration_ms, status, started_at, stdout_artifact, stderr_artifact, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const command of commands) {
      statement.run(
        runId,
        command.capability,
        command.command,
        JSON.stringify(command.args),
        command.cwd,
        command.exitCode ?? null,
        command.durationMs,
        command.status,
        command.startedAt,
        command.stdoutArtifact ?? null,
        command.stderrArtifact ?? null,
        command.reason ?? null
      );
    }
  }

  addAuthProfiles(runId: string, profiles: AuthProfileReport[]): void {
    const statement = this.database.prepare(
      `INSERT INTO auth_profiles (run_id, name, login_url, username_ref, success_json, session_artifact)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, name) DO UPDATE SET
         login_url = excluded.login_url,
         username_ref = excluded.username_ref,
         success_json = excluded.success_json,
         session_artifact = excluded.session_artifact`
    );

    for (const profile of profiles) {
      statement.run(runId, profile.name, profile.loginUrl, profile.usernameRef, JSON.stringify(profile.success), profile.sessionArtifact ?? null);
    }
  }

  addRegisteredTests(runId: string, tests: BrowserTestMetadata[]): void {
    const statement = this.database.prepare(
      `INSERT INTO registered_tests (run_id, key, title, layer, tags_json, priority, profile, timeout_ms, dependencies_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, key) DO UPDATE SET
         title = excluded.title,
         tags_json = excluded.tags_json,
         priority = excluded.priority,
         profile = excluded.profile,
         timeout_ms = excluded.timeout_ms,
         dependencies_json = excluded.dependencies_json`
    );

    for (const test of tests) {
      statement.run(runId, test.key, test.title, test.layer, JSON.stringify(test.tags), test.priority, test.profile ?? null, test.timeoutMs, JSON.stringify(test.dependencies));
    }
  }

  getRunReportData(runId: string): RunReportData {
    const run = this.getRun(runId);
    const project = this.getProject(run.projectId);
    const target = this.getTarget(run.targetId);
    const results = this.database.prepare("SELECT * FROM test_results WHERE run_id = ? ORDER BY started_at, test_key").all(runId) as unknown as ResultRow[];

    return {
      project,
      target,
      run,
      sourceProject: sourceProjectFromRow(this.database.prepare("SELECT * FROM source_projects WHERE run_id = ?").get(runId) as SourceProjectRow | undefined),
      sourceCommands: (this.database.prepare("SELECT * FROM source_commands WHERE run_id = ? ORDER BY started_at, capability").all(runId) as unknown as SourceCommandRow[]).map(
        sourceCommandFromRow
      ),
      pages: (this.database.prepare("SELECT * FROM discovered_pages WHERE run_id = ? ORDER BY discovered_at, normalized_url").all(runId) as unknown as DiscoveredPageRow[]).map(
        discoveredPageFromRow
      ),
      apiEndpoints: (this.database.prepare("SELECT * FROM api_endpoints WHERE run_id = ? ORDER BY method, normalized_path").all(runId) as unknown as ApiEndpointRow[]).map(
        apiEndpointFromRow
      ),
      authProfiles: (this.database.prepare("SELECT * FROM auth_profiles WHERE run_id = ? ORDER BY name").all(runId) as unknown as AuthProfileRow[]).map(authProfileFromRow),
      registeredTests: (this.database.prepare("SELECT * FROM registered_tests WHERE run_id = ? ORDER BY priority, key").all(runId) as unknown as RegisteredTestRow[]).map(
        registeredTestFromRow
      ),
      results: results.map(resultFromRow),
      findings: (this.database.prepare("SELECT * FROM findings WHERE run_id = ? ORDER BY category, title").all(runId) as unknown as FindingRow[]).map(findingFromRow),
      evidence: (this.database.prepare("SELECT * FROM evidence WHERE run_id = ? ORDER BY relative_path").all(runId) as unknown as EvidenceRow[]).map(evidenceFromRow),
      summary: run.summary ?? {
        passed: false,
        total: 0,
        pass: 0,
        fail: 0,
        error: 0,
        blocked: 0,
        skipped: 0,
        durationMs: 0
      }
    };
  }

  private get database(): DatabaseSync {
    if (!this.db) {
      this.initialize();
    }
    return this.db as DatabaseSync;
  }

  private getProject(id: string): ProjectRecord {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    if (!row) {
      throw new Error(`Project not found: ${id}`);
    }
    return projectFromRow(row);
  }

  private getTarget(id: string): TargetRecord {
    const row = this.database.prepare("SELECT * FROM targets WHERE id = ?").get(id) as TargetRow | undefined;
    if (!row) {
      throw new Error(`Target not found: ${id}`);
    }
    return targetFromRow(row);
  }

  private getRun(id: string): RunRecord {
    const row = this.database.prepare("SELECT * FROM test_runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) {
      throw new Error(`Run not found: ${id}`);
    }
    return runFromRow(row);
  }

  private findBaselineById(id: string): BaselineRecord | undefined {
    const row = this.database.prepare("SELECT * FROM baselines WHERE id = ?").get(id) as BaselineRow | undefined;
    return row ? baselineFromRow(row) : undefined;
  }

  private getBaselineById(id: string): BaselineRecord {
    const baseline = this.findBaselineById(id);
    if (!baseline) {
      throw new RegressionStorageError("Baseline not found.", [`baseline '${id}' was not found`]);
    }
    return baseline;
  }
}

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    settingsRef: row.settings_ref ?? undefined,
    createdAt: row.created_at
  };
}

function targetFromRow(row: TargetRow): TargetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    mode: row.mode,
    url: row.url ?? undefined,
    sourcePath: row.source_path ?? undefined,
    environment: row.environment,
    allowedHosts: JSON.parse(row.allowed_hosts_json) as string[],
    createdAt: row.created_at
  };
}

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    targetId: row.target_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    toolVersions: JSON.parse(row.tool_versions_json) as Record<string, string>,
    summary: row.summary_json ? (JSON.parse(row.summary_json) as QualityGateSummary) : undefined,
    artifactDir: row.artifact_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function resultFromRow(row: ResultRow): NormalizedResult {
  return {
    id: row.id,
    runId: row.run_id,
    testKey: row.test_key,
    layer: row.layer,
    title: row.title,
    status: row.status,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    targetRef: row.target_ref,
    roleProfile: row.role_profile ?? undefined,
    priority: row.priority ?? undefined,
    tags: row.tags_json ? (JSON.parse(row.tags_json) as string[]) : undefined,
    dependencies: row.dependencies_json ? (JSON.parse(row.dependencies_json) as string[]) : undefined,
    error: row.error_text ?? undefined,
    expected: row.expected_json ? JSON.parse(row.expected_json) : undefined,
    actual: row.actual_json ? JSON.parse(row.actual_json) : undefined,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as EvidenceRef[],
    findingRefs: JSON.parse(row.finding_refs_json) as string[],
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version
  };
}

function discoveredPageFromRow(row: DiscoveredPageRow): DiscoveredPage {
  return {
    id: row.id,
    runId: row.run_id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    finalUrl: row.final_url ?? undefined,
    statusCode: row.status_code ?? undefined,
    title: row.title ?? undefined,
    linkCount: row.link_count,
    formCount: row.form_count,
    buttonCount: row.button_count,
    redirectCount: row.redirect_count,
    consoleErrors: JSON.parse(row.console_errors_json) as string[],
    networkErrors: JSON.parse(row.network_errors_json) as string[],
    discoveredAt: row.discovered_at
  };
}

function apiEndpointFromRow(row: ApiEndpointRow): ApiEndpoint {
  return {
    id: row.id,
    runId: row.run_id,
    method: row.method,
    normalizedPath: row.normalized_path,
    statusCodes: JSON.parse(row.status_codes_json) as number[],
    count: row.count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

function findingFromRow(row: FindingRow): Finding {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    category: row.category,
    severity: row.severity,
    title: row.title,
    description: row.description,
    url: row.url ?? undefined,
    method: row.method ?? undefined,
    endpoint: row.endpoint ?? undefined,
    roleProfile: row.role_profile ?? undefined,
    remediationHint: row.remediation_hint ?? undefined,
    details: row.details_json ? (JSON.parse(row.details_json) as Record<string, unknown>) : undefined,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as EvidenceRef[],
    redactionApplied: row.redaction_applied === 1
  };
}

function evidenceFromRow(row: EvidenceRow): EvidenceRef {
  return {
    id: row.id,
    type: row.type,
    relativePath: row.relative_path,
    sha256: row.sha256 ?? undefined,
    size: row.size ?? undefined
  };
}

function authProfileFromRow(row: AuthProfileRow): AuthProfileReport {
  return {
    name: row.name,
    loginUrl: row.login_url,
    usernameRef: row.username_ref,
    success: JSON.parse(row.success_json) as AuthProfileReport["success"],
    sessionArtifact: row.session_artifact ?? undefined
  };
}

function registeredTestFromRow(row: RegisteredTestRow): BrowserTestMetadata {
  return {
    key: row.key,
    title: row.title,
    layer: row.layer,
    tags: JSON.parse(row.tags_json) as string[],
    priority: row.priority,
    profile: row.profile ?? undefined,
    timeoutMs: row.timeout_ms,
    dependencies: JSON.parse(row.dependencies_json) as string[]
  };
}

function sourceProjectFromRow(row?: SourceProjectRow): SourceProjectReport | undefined {
  if (!row) {
    return undefined;
  }
  return {
    path: row.path,
    runtime: row.runtime,
    framework: row.framework,
    confidence: row.confidence,
    runtimeVersion: row.runtime_version ?? undefined,
    packageManager: row.package_manager ?? undefined,
    markers: JSON.parse(row.markers_json) as string[],
    adapterId: row.adapter_id,
    support: row.support,
    capabilities: JSON.parse(row.capabilities_json) as SourceProjectReport["capabilities"],
    inspectOnly: row.inspect_only === 1,
    reason: row.reason ?? undefined
  };
}

function sourceCommandFromRow(row: SourceCommandRow): SourceCommandReport {
  return {
    capability: row.capability,
    command: row.command,
    args: JSON.parse(row.args_json) as string[],
    cwd: row.cwd,
    exitCode: row.exit_code ?? undefined,
    durationMs: row.duration_ms,
    status: row.status,
    startedAt: row.started_at,
    stdoutArtifact: row.stdout_artifact ?? undefined,
    stderrArtifact: row.stderr_artifact ?? undefined,
    reason: row.reason ?? undefined
  };
}

function baselineFromRow(row: BaselineRow): BaselineRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    name: row.name,
    createdAt: row.created_at
  };
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function stableStorageId(prefix: string, input: unknown[]): string {
  return `${prefix}_${createHash("sha256").update(input.join("|")).digest("hex").slice(0, 16)}`;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  mode TEXT NOT NULL,
  url TEXT,
  source_path TEXT,
  environment TEXT NOT NULL,
  allowed_hosts_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  target_id TEXT NOT NULL REFERENCES targets(id),
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  tool_versions_json TEXT NOT NULL,
  summary_json TEXT,
  artifact_dir TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES test_runs(id),
  test_key TEXT NOT NULL,
  layer TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  target_ref TEXT NOT NULL,
  role_profile TEXT,
  priority TEXT,
  tags_json TEXT,
  dependencies_json TEXT,
  error_text TEXT,
  expected_json TEXT,
  actual_json TEXT,
  evidence_refs_json TEXT NOT NULL,
  finding_refs_json TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_test_runs_project_id ON test_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_test_results_run_id ON test_results(run_id);

CREATE TABLE IF NOT EXISTS baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id TEXT NOT NULL REFERENCES test_runs(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_baselines_project_id ON baselines(project_id);
CREATE INDEX IF NOT EXISTS idx_baselines_run_id ON baselines(run_id);

CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  baseline_id TEXT NOT NULL REFERENCES baselines(id),
  baseline_run_id TEXT NOT NULL REFERENCES test_runs(id),
  current_run_id TEXT NOT NULL REFERENCES test_runs(id),
  summary_json TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  finding_entries_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comparisons_project_id ON comparisons(project_id);
CREATE INDEX IF NOT EXISTS idx_comparisons_current_run_id ON comparisons(current_run_id);

CREATE TABLE IF NOT EXISTS discovered_pages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES test_runs(id),
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  final_url TEXT,
  status_code INTEGER,
  title TEXT,
  link_count INTEGER NOT NULL,
  form_count INTEGER NOT NULL,
  button_count INTEGER NOT NULL DEFAULT 0,
  redirect_count INTEGER NOT NULL DEFAULT 0,
  console_errors_json TEXT NOT NULL,
  network_errors_json TEXT NOT NULL,
  discovered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_endpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES test_runs(id),
  method TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  status_codes_json TEXT NOT NULL,
  count INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES test_runs(id),
  fingerprint TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  url TEXT,
  method TEXT,
  endpoint TEXT,
  role_profile TEXT,
  remediation_hint TEXT,
  details_json TEXT,
  evidence_refs_json TEXT NOT NULL,
  redaction_applied INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES test_runs(id),
  type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT,
  size INTEGER
);

CREATE INDEX IF NOT EXISTS idx_discovered_pages_run_id ON discovered_pages(run_id);
CREATE INDEX IF NOT EXISTS idx_api_endpoints_run_id ON api_endpoints(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_run_id ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_evidence_run_id ON evidence(run_id);

CREATE TABLE IF NOT EXISTS source_projects (
  run_id TEXT PRIMARY KEY REFERENCES test_runs(id),
  path TEXT NOT NULL,
  runtime TEXT NOT NULL,
  framework TEXT NOT NULL,
  confidence TEXT NOT NULL,
  runtime_version TEXT,
  package_manager TEXT,
  markers_json TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  support TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  inspect_only INTEGER NOT NULL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS source_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES test_runs(id),
  capability TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stdout_artifact TEXT,
  stderr_artifact TEXT,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_commands_run_id ON source_commands(run_id);

CREATE TABLE IF NOT EXISTS auth_profiles (
  run_id TEXT NOT NULL REFERENCES test_runs(id),
  name TEXT NOT NULL,
  login_url TEXT NOT NULL,
  username_ref TEXT NOT NULL,
  success_json TEXT NOT NULL,
  session_artifact TEXT,
  PRIMARY KEY (run_id, name)
);

CREATE TABLE IF NOT EXISTS registered_tests (
  run_id TEXT NOT NULL REFERENCES test_runs(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  layer TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  priority TEXT NOT NULL,
  profile TEXT,
  timeout_ms INTEGER NOT NULL,
  dependencies_json TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);

CREATE INDEX IF NOT EXISTS idx_auth_profiles_run_id ON auth_profiles(run_id);
CREATE INDEX IF NOT EXISTS idx_registered_tests_run_id ON registered_tests(run_id);
`;

export type { Finding };
