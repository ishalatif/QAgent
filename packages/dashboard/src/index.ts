import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, resolve, sep } from "node:path";
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
  RunRecord,
  RunReportData,
  RunStatus,
  SourceCommandReport,
  SourceProjectReport,
  TargetEnvironment,
  TargetMode,
  TargetRecord
} from "#contracts";

export interface DashboardServerOptions {
  dbPath: string;
  host?: string;
  port?: number;
  runTrigger?: DashboardRunTriggerOptions;
}

export interface DashboardServerHandle {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface DashboardRunTriggerOptions {
  enabled: boolean;
  trigger(request: DashboardRunTriggerRequest): Promise<DashboardRunTriggerResult>;
}

export interface DashboardRunTriggerRequest {
  url?: string;
  sourcePath?: string;
  configPath?: string;
  profile?: string;
  layers?: string[];
  allowSourceCommands?: boolean;
  inspectOnly?: boolean;
}

export interface DashboardRunTriggerResult {
  runId: string;
  status: string;
  exitCode: number;
  summary: QualityGateSummary;
  reportOutput: {
    runId: string;
    rootDir: string;
    jsonPath?: string;
    htmlPath?: string;
    junitPath?: string;
    xlsxPath?: string;
  };
}

export interface DashboardProjectSummary {
  project: ProjectRecord;
  runCount: number;
  latestRun?: {
    id: string;
    status: RunStatus;
    startedAt: string;
    completedAt?: string;
    summary?: QualityGateSummary;
  };
}

export interface DashboardRunOverview {
  project: ProjectRecord;
  target: TargetRecord;
  run: RunRecord;
  resultCount: number;
  findingCount: number;
  evidenceCount: number;
  failedResultCount: number;
  criticalFindingCount: number;
}

export interface DashboardBaselineSummary extends BaselineRecord {
  projectName: string;
  runStatus: RunStatus;
  runStartedAt: string;
}

export interface DashboardDiagnostics {
  node: string;
  database: {
    path: string;
    exists: boolean;
  };
  server: {
    mode: "local-readonly" | "local-trigger-enabled";
  };
}

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

interface ProjectSummaryRow extends ProjectRow {
  run_count: number;
  latest_run_id: string | null;
  latest_status: RunStatus | null;
  latest_started_at: string | null;
  latest_completed_at: string | null;
  latest_summary_json: string | null;
}

interface RunOverviewRow extends RunRow {
  project_name: string;
  project_settings_ref: string | null;
  project_created_at: string;
  target_mode: TargetMode;
  target_url: string | null;
  target_source_path: string | null;
  target_environment: TargetEnvironment;
  target_allowed_hosts_json: string;
  target_created_at: string;
  result_count: number;
  finding_count: number;
  evidence_count: number;
  failed_result_count: number;
  critical_finding_count: number;
}

interface BaselineSummaryRow {
  id: string;
  project_id: string;
  run_id: string;
  name: string;
  created_at: string;
  project_name: string;
  run_status: RunStatus;
  run_started_at: string;
}

interface EvidenceDownloadRow extends EvidenceRow {
  artifact_dir: string;
}

export class DashboardApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

export class DashboardRepository {
  private db?: DatabaseSync;

  constructor(
    readonly dbPath: string,
    private readonly mode: DashboardDiagnostics["server"]["mode"] = "local-readonly"
  ) {}

  diagnostics(): DashboardDiagnostics {
    return {
      node: process.versions.node,
      database: {
        path: this.dbPath,
        exists: existsSync(this.dbPath)
      },
      server: {
        mode: this.mode
      }
    };
  }

  listProjects(): DashboardProjectSummary[] {
    const db = this.openIfExists();
    if (!db) {
      return [];
    }

    return (
      db
        .prepare(
          `SELECT
             p.id, p.name, p.settings_ref, p.created_at,
             COUNT(r.id) AS run_count,
             lr.id AS latest_run_id,
             lr.status AS latest_status,
             lr.started_at AS latest_started_at,
             lr.completed_at AS latest_completed_at,
             lr.summary_json AS latest_summary_json
           FROM projects p
           LEFT JOIN test_runs r ON r.project_id = p.id
           LEFT JOIN test_runs lr ON lr.id = (
             SELECT id FROM test_runs WHERE project_id = p.id ORDER BY started_at DESC LIMIT 1
           )
           GROUP BY p.id, p.name, p.settings_ref, p.created_at, lr.id, lr.status, lr.started_at, lr.completed_at, lr.summary_json
           ORDER BY COALESCE(lr.started_at, p.created_at) DESC, p.name`
        )
        .all() as unknown as ProjectSummaryRow[]
    ).map((row) => ({
      project: projectFromRow(row),
      runCount: row.run_count,
      latestRun:
        row.latest_run_id && row.latest_status && row.latest_started_at
          ? {
              id: row.latest_run_id,
              status: row.latest_status,
              startedAt: row.latest_started_at,
              completedAt: row.latest_completed_at ?? undefined,
              summary: parseJson<QualityGateSummary>(row.latest_summary_json)
            }
          : undefined
    }));
  }

  listRuns(input: { projectId?: string; limit?: number } = {}): DashboardRunOverview[] {
    const db = this.openIfExists();
    if (!db) {
      return [];
    }

    const limit = clampInteger(input.limit ?? 50, 1, 500);
    const rows = db
      .prepare(
        `SELECT
           r.*,
           p.name AS project_name,
           p.settings_ref AS project_settings_ref,
           p.created_at AS project_created_at,
           t.mode AS target_mode,
           t.url AS target_url,
           t.source_path AS target_source_path,
           t.environment AS target_environment,
           t.allowed_hosts_json AS target_allowed_hosts_json,
           t.created_at AS target_created_at,
           (SELECT COUNT(*) FROM test_results tr WHERE tr.run_id = r.id) AS result_count,
           (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.id) AS finding_count,
           (SELECT COUNT(*) FROM evidence e WHERE e.run_id = r.id) AS evidence_count,
           (SELECT COUNT(*) FROM test_results tr WHERE tr.run_id = r.id AND tr.status IN ('FAIL', 'ERROR', 'BLOCKED')) AS failed_result_count,
           (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.id AND f.severity = 'Critical') AS critical_finding_count
         FROM test_runs r
         JOIN projects p ON p.id = r.project_id
         JOIN targets t ON t.id = r.target_id
         WHERE (? IS NULL OR r.project_id = ?)
         ORDER BY r.started_at DESC
         LIMIT ?`
      )
      .all(input.projectId ?? null, input.projectId ?? null, limit) as unknown as RunOverviewRow[];

    return rows.map(runOverviewFromRow);
  }

  listFindings(input: { runId?: string; severity?: string; category?: string; limit?: number } = {}): Finding[] {
    const db = this.openIfExists();
    if (!db) {
      return [];
    }

    const limit = clampInteger(input.limit ?? 200, 1, 1000);
    const rows = db
      .prepare(
        `SELECT * FROM findings
         WHERE (? IS NULL OR run_id = ?)
           AND (? IS NULL OR severity = ?)
           AND (? IS NULL OR category = ?)
         ORDER BY
           CASE severity
             WHEN 'Critical' THEN 0
             WHEN 'High' THEN 1
             WHEN 'Medium' THEN 2
             WHEN 'Low' THEN 3
             ELSE 4
           END,
           category,
           title
         LIMIT ?`
      )
      .all(input.runId ?? null, input.runId ?? null, input.severity ?? null, input.severity ?? null, input.category ?? null, input.category ?? null, limit) as unknown as FindingRow[];

    return rows.map(findingFromRow);
  }

  listBaselines(input: { projectId?: string } = {}): DashboardBaselineSummary[] {
    const db = this.openIfExists();
    if (!db) {
      return [];
    }

    const rows = db
      .prepare(
        `SELECT
           b.id, b.project_id, b.run_id, b.name, b.created_at,
           p.name AS project_name,
           r.status AS run_status,
           r.started_at AS run_started_at
         FROM baselines b
         JOIN projects p ON p.id = b.project_id
         JOIN test_runs r ON r.id = b.run_id
         WHERE (? IS NULL OR b.project_id = ?)
         ORDER BY b.created_at DESC, b.name`
      )
      .all(input.projectId ?? null, input.projectId ?? null) as unknown as BaselineSummaryRow[];

    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      runId: row.run_id,
      name: row.name,
      createdAt: row.created_at,
      projectName: row.project_name,
      runStatus: row.run_status,
      runStartedAt: row.run_started_at
    }));
  }

  getRunOverview(runId: string): DashboardRunOverview {
    const db = this.requireDatabase();
    const row = db
      .prepare(
        `SELECT
           r.*,
           p.name AS project_name,
           p.settings_ref AS project_settings_ref,
           p.created_at AS project_created_at,
           t.mode AS target_mode,
           t.url AS target_url,
           t.source_path AS target_source_path,
           t.environment AS target_environment,
           t.allowed_hosts_json AS target_allowed_hosts_json,
           t.created_at AS target_created_at,
           (SELECT COUNT(*) FROM test_results tr WHERE tr.run_id = r.id) AS result_count,
           (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.id) AS finding_count,
           (SELECT COUNT(*) FROM evidence e WHERE e.run_id = r.id) AS evidence_count,
           (SELECT COUNT(*) FROM test_results tr WHERE tr.run_id = r.id AND tr.status IN ('FAIL', 'ERROR', 'BLOCKED')) AS failed_result_count,
           (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.id AND f.severity = 'Critical') AS critical_finding_count
         FROM test_runs r
         JOIN projects p ON p.id = r.project_id
         JOIN targets t ON t.id = r.target_id
         WHERE r.id = ?`
      )
      .get(runId) as RunOverviewRow | undefined;

    if (!row) {
      throw new DashboardApiError(404, "RUN_NOT_FOUND", `Run not found: ${runId}`);
    }
    return runOverviewFromRow(row);
  }

  getRunReport(runId: string): RunReportData {
    const overview = this.getRunOverview(runId);
    const db = this.requireDatabase();
    const results = db.prepare("SELECT * FROM test_results WHERE run_id = ? ORDER BY started_at, test_key").all(runId) as unknown as ResultRow[];

    return {
      project: overview.project,
      target: overview.target,
      run: overview.run,
      sourceProject: sourceProjectFromRow(db.prepare("SELECT * FROM source_projects WHERE run_id = ?").get(runId) as SourceProjectRow | undefined),
      sourceCommands: (db.prepare("SELECT * FROM source_commands WHERE run_id = ? ORDER BY started_at, capability").all(runId) as unknown as SourceCommandRow[]).map(
        sourceCommandFromRow
      ),
      pages: (db.prepare("SELECT * FROM discovered_pages WHERE run_id = ? ORDER BY discovered_at, normalized_url").all(runId) as unknown as DiscoveredPageRow[]).map(
        discoveredPageFromRow
      ),
      apiEndpoints: (db.prepare("SELECT * FROM api_endpoints WHERE run_id = ? ORDER BY method, normalized_path").all(runId) as unknown as ApiEndpointRow[]).map(
        apiEndpointFromRow
      ),
      authProfiles: (db.prepare("SELECT * FROM auth_profiles WHERE run_id = ? ORDER BY name").all(runId) as unknown as AuthProfileRow[]).map(authProfileFromRow),
      registeredTests: (db.prepare("SELECT * FROM registered_tests WHERE run_id = ? ORDER BY priority, key").all(runId) as unknown as RegisteredTestRow[]).map(
        registeredTestFromRow
      ),
      results: results.map(resultFromRow),
      findings: (db.prepare("SELECT * FROM findings WHERE run_id = ? ORDER BY category, title").all(runId) as unknown as FindingRow[]).map(findingFromRow),
      evidence: (db.prepare("SELECT * FROM evidence WHERE run_id = ? ORDER BY relative_path").all(runId) as unknown as EvidenceRow[]).map(evidenceFromRow),
      summary: overview.run.summary ?? emptySummary()
    };
  }

  getEvidenceDownload(evidenceId: string): { evidence: EvidenceRef; absolutePath: string } {
    const db = this.requireDatabase();
    const row = db
      .prepare(
        `SELECT e.*, r.artifact_dir
         FROM evidence e
         JOIN test_runs r ON r.id = e.run_id
         WHERE e.id = ?`
      )
      .get(evidenceId) as EvidenceDownloadRow | undefined;

    if (!row) {
      throw new DashboardApiError(404, "EVIDENCE_NOT_FOUND", `Evidence not found: ${evidenceId}`);
    }

    const artifactDir = resolve(row.artifact_dir);
    const absolutePath = resolve(artifactDir, row.relative_path);
    if (!isPathInside(artifactDir, absolutePath)) {
      throw new DashboardApiError(403, "EVIDENCE_PATH_DENIED", "Evidence path is outside the run artifact directory.");
    }
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new DashboardApiError(404, "EVIDENCE_FILE_NOT_FOUND", `Evidence file not found: ${row.relative_path}`);
    }

    return {
      evidence: evidenceFromRow(row),
      absolutePath
    };
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private requireDatabase(): DatabaseSync {
    const db = this.openIfExists();
    if (!db) {
      throw new DashboardApiError(404, "DATABASE_NOT_FOUND", `QAgent database not found: ${this.dbPath}`);
    }
    return db;
  }

  private openIfExists(): DatabaseSync | undefined {
    if (!existsSync(this.dbPath)) {
      return undefined;
    }

    if (!this.db) {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      this.db.exec("PRAGMA query_only = ON;");
    }
    return this.db;
  }
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<DashboardServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 4810;
  const repository = new DashboardRepository(resolve(options.dbPath), options.runTrigger?.enabled ? "local-trigger-enabled" : "local-readonly");
  const server = createServer((request, response) => {
    void handleDashboardRequest({ request, response, repository, runTrigger: options.runTrigger }).catch((error) => {
      sendApiError(response, error);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const reject = (error: Error): void => rejectListen(error);
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  const actualPort = serverPort(server, requestedPort);
  return {
    url: `http://${host}:${actualPort}`,
    host,
    port: actualPort,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          repository.close();
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
  };
}

export function standardSuccess<T>(data: T, traceId = randomUUID()): { success: true; data: T; meta: { traceId: string } } {
  return {
    success: true,
    data,
    meta: { traceId }
  };
}

export function standardError(error: DashboardApiError, traceId = randomUUID()): {
  success: false;
  error: { code: string; message: string; details: unknown };
  traceId: string;
} {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details
    },
    traceId
  };
}

export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const comparableRoot = normalizeForPathCompare(resolvedRoot);
  const comparableCandidate = normalizeForPathCompare(resolvedCandidate);
  const rootPrefix = comparableRoot.endsWith(sep) ? comparableRoot : `${comparableRoot}${sep}`;
  return comparableCandidate === comparableRoot || comparableCandidate.startsWith(rootPrefix);
}

async function handleDashboardRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  repository: DashboardRepository;
  runTrigger?: DashboardRunTriggerOptions;
}): Promise<void> {
  const method = input.request.method ?? "GET";
  const url = new URL(input.request.url ?? "/", "http://qagent.local");

  if (method === "POST" && url.pathname === "/api/v1/runs") {
    if (!input.runTrigger?.enabled) {
      throw new DashboardApiError(403, "RUN_TRIGGER_DISABLED", "Run triggering is disabled for this dashboard server.");
    }
    const triggerRequest = normalizeRunTriggerRequest(await readJsonBody(input.request));
    sendJson(input.response, 201, standardSuccess(await input.runTrigger.trigger(triggerRequest)));
    return;
  }

  if (method !== "GET") {
    throw new DashboardApiError(405, "METHOD_NOT_ALLOWED", `${method} is not supported by the dashboard beta.`);
  }

  if (url.pathname === "/health" || url.pathname === "/ready") {
    sendJson(input.response, 200, standardSuccess({ ok: true, diagnostics: input.repository.diagnostics() }));
    return;
  }

  if (url.pathname === "/api/v1/system/diagnostics") {
    sendJson(input.response, 200, standardSuccess(input.repository.diagnostics()));
    return;
  }

  if (url.pathname === "/api/v1/projects") {
    sendJson(input.response, 200, standardSuccess(input.repository.listProjects()));
    return;
  }

  if (url.pathname === "/api/v1/runs") {
    sendJson(
      input.response,
      200,
      standardSuccess(
        input.repository.listRuns({
          projectId: searchValue(url, "projectId"),
          limit: numberSearchValue(url, "limit")
        })
      )
    );
    return;
  }

  if (url.pathname === "/api/v1/findings") {
    sendJson(
      input.response,
      200,
      standardSuccess(
        input.repository.listFindings({
          runId: searchValue(url, "runId"),
          severity: searchValue(url, "severity"),
          category: searchValue(url, "category"),
          limit: numberSearchValue(url, "limit")
        })
      )
    );
    return;
  }

  if (url.pathname === "/api/v1/baselines") {
    sendJson(input.response, 200, standardSuccess(input.repository.listBaselines({ projectId: searchValue(url, "projectId") })));
    return;
  }

  const segments = pathSegments(url.pathname);
  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "runs" && segments[3] && segments.length === 4) {
    sendJson(input.response, 200, standardSuccess(input.repository.getRunOverview(segments[3])));
    return;
  }

  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "runs" && segments[3] && segments[4] === "report" && segments.length === 5) {
    sendJson(input.response, 200, standardSuccess(input.repository.getRunReport(segments[3])));
    return;
  }

  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "evidence" && segments[3] && segments.length === 4) {
    sendEvidence(input.response, input.repository.getEvidenceDownload(segments[3]));
    return;
  }

  if (segments[0] === "api") {
    throw new DashboardApiError(404, "API_NOT_FOUND", `API route not found: ${url.pathname}`);
  }

  sendHtml(input.response, renderDashboardHtml());
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > 64 * 1024) {
      throw new DashboardApiError(413, "REQUEST_TOO_LARGE", "Run trigger request body is too large.");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    throw new DashboardApiError(400, "INVALID_JSON", "Run trigger request body must be JSON.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new DashboardApiError(400, "INVALID_JSON", "Run trigger request body must be valid JSON.");
  }
}

function normalizeRunTriggerRequest(input: unknown): DashboardRunTriggerRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DashboardApiError(400, "INVALID_RUN_TRIGGER", "Run trigger request must be a JSON object.");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set(["url", "sourcePath", "configPath", "profile", "layers", "allowSourceCommands", "inspectOnly"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new DashboardApiError(400, "INVALID_RUN_TRIGGER", `Unknown run trigger field: ${unknown.join(", ")}`);
  }

  const url = optionalString(value.url, "url");
  const sourcePath = optionalString(value.sourcePath, "sourcePath");
  if (Boolean(url) === Boolean(sourcePath)) {
    throw new DashboardApiError(400, "INVALID_RUN_TRIGGER", "Run trigger must provide exactly one of url or sourcePath.");
  }

  return {
    url,
    sourcePath,
    configPath: optionalString(value.configPath, "configPath"),
    profile: optionalString(value.profile, "profile"),
    layers: optionalStringArray(value.layers, "layers"),
    allowSourceCommands: optionalBoolean(value.allowSourceCommands, "allowSourceCommands"),
    inspectOnly: optionalBoolean(value.inspectOnly, "inspectOnly")
  };
}

function optionalString(input: unknown, field: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "string" || input.trim() === "") {
    throw new DashboardApiError(400, "INVALID_RUN_TRIGGER", `${field} must be a non-empty string.`);
  }
  return input.trim();
}

function optionalBoolean(input: unknown, field: string): boolean | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "boolean") {
    throw new DashboardApiError(400, "INVALID_RUN_TRIGGER", `${field} must be a boolean.`);
  }
  return input;
}

function optionalStringArray(input: unknown, field: string): string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input) || input.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new DashboardApiError(400, "INVALID_RUN_TRIGGER", `${field} must be an array of non-empty strings.`);
  }
  return input.map((item) => item.trim());
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(html);
}

function sendEvidence(response: ServerResponse, input: { evidence: EvidenceRef; absolutePath: string }): void {
  const fileName = basename(input.evidence.relativePath).replace(/[^a-zA-Z0-9._-]/g, "_") || "evidence";
  response.statusCode = 200;
  response.setHeader("content-type", contentType(input.evidence));
  response.setHeader("content-disposition", `inline; filename="${fileName}"`);
  response.setHeader("cache-control", "no-store");
  createReadStream(input.absolutePath).pipe(response);
}

function sendApiError(response: ServerResponse, error: unknown): void {
  const apiError =
    error instanceof DashboardApiError
      ? error
      : new DashboardApiError(500, "DASHBOARD_ERROR", error instanceof Error ? error.message : "Unexpected dashboard error");
  sendJson(response, apiError.statusCode, standardError(apiError));
}

function contentType(evidence: EvidenceRef): string {
  if (evidence.type === "screenshot") {
    return "image/png";
  }
  if (evidence.type === "trace") {
    return "application/zip";
  }
  if (evidence.type === "html") {
    return "text/html; charset=utf-8";
  }
  if (evidence.type === "junit") {
    return "application/xml; charset=utf-8";
  }
  if (evidence.type === "json") {
    return "application/json; charset=utf-8";
  }
  if (evidence.type === "log") {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QAgent Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --ink: #17202a;
      --muted: #5d6876;
      --line: #d9dee7;
      --accent: #1769aa;
      --pass: #0b7a47;
      --fail: #b3261e;
      --warn: #8a5a00;
      --blocked: #5f4b8b;
      --shadow: 0 1px 3px rgba(23, 32, 42, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-width: 320px;
      background: var(--bg);
      color: var(--ink);
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
      line-height: 1.45;
      letter-spacing: 0;
    }

    a {
      color: var(--accent);
    }

    button,
    select,
    input {
      font: inherit;
    }

    button:focus-visible,
    select:focus-visible,
    input:focus-visible,
    a:focus-visible {
      outline: 3px solid #f5c84c;
      outline-offset: 2px;
    }

    .shell {
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      min-height: 100vh;
    }

    .sidebar {
      border-right: 1px solid var(--line);
      background: #eef2f6;
      padding: 18px;
    }

    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
    }

    .brand h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.1;
    }

    .brand span {
      color: var(--muted);
      font-size: 12px;
    }

    .refresh {
      min-width: 40px;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--ink);
      cursor: pointer;
    }

    .refresh:hover {
      border-color: var(--accent);
    }

    .stack {
      display: grid;
      gap: 14px;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .panel header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }

    .panel h2,
    .panel h3 {
      margin: 0;
      font-size: 15px;
    }

    .panel-body {
      padding: 12px 14px;
    }

    .main {
      padding: 18px;
      min-width: 0;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(110px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }

    .metric {
      min-height: 78px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 12px;
      box-shadow: var(--shadow);
    }

    .metric span {
      color: var(--muted);
      display: block;
      font-size: 12px;
    }

    .metric strong {
      display: block;
      margin-top: 5px;
      font-size: 24px;
      line-height: 1.1;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      border-bottom: 1px solid var(--line);
      padding: 9px 10px;
      text-align: left;
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      background: #fafbfc;
    }

    tbody tr:hover {
      background: #f4f8fb;
    }

    .run-button {
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--accent);
      text-align: left;
      cursor: pointer;
      font-weight: 700;
    }

    .status {
      display: inline-flex;
      min-width: 78px;
      justify-content: center;
      border: 1px solid currentColor;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 700;
    }

    .status-pass,
    .status-completed {
      color: var(--pass);
    }

    .status-fail,
    .status-error,
    .status-failed,
    .status-critical,
    .status-high {
      color: var(--fail);
    }

    .status-blocked,
    .status-cancelled {
      color: var(--blocked);
    }

    .status-skipped,
    .status-medium,
    .status-low,
    .status-info {
      color: var(--warn);
    }

    .filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }

    .filters label {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .filters select,
    .filters input {
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 6px 8px;
    }

    .empty,
    .error {
      color: var(--muted);
      padding: 18px 0;
    }

    .error {
      color: var(--fail);
      font-weight: 700;
    }

    .mono {
      font-family: Consolas, Monaco, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .tabs {
      display: flex;
      gap: 6px;
      margin: 14px 0;
      border-bottom: 1px solid var(--line);
    }

    .tab {
      min-height: 38px;
      border: 1px solid transparent;
      border-bottom: 0;
      border-radius: 6px 6px 0 0;
      background: transparent;
      color: var(--muted);
      padding: 8px 12px;
      cursor: pointer;
    }

    .tab[aria-selected="true"] {
      border-color: var(--line);
      background: var(--panel);
      color: var(--ink);
      font-weight: 700;
    }

    .hidden {
      display: none;
    }

    .detail-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 12px;
    }

    .detail-header h2 {
      margin: 0 0 4px;
      font-size: 22px;
    }

    .detail-header p {
      margin: 0;
      color: var(--muted);
    }

    @media (max-width: 980px) {
      .shell {
        grid-template-columns: 1fr;
      }

      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      .metrics {
        grid-template-columns: repeat(2, minmax(120px, 1fr));
      }
    }

    @media (max-width: 640px) {
      .main,
      .sidebar {
        padding: 12px;
      }

      .metrics {
        grid-template-columns: 1fr;
      }

      th:nth-child(4),
      td:nth-child(4) {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar" aria-label="Dashboard navigation">
      <div class="brand">
        <div>
          <h1>QAgent</h1>
          <span>Dashboard beta</span>
        </div>
        <button class="refresh" id="refresh" type="button" aria-label="Refresh dashboard" title="Refresh dashboard">R</button>
      </div>
      <div class="stack">
        <section class="panel" aria-labelledby="projects-title">
          <header><h2 id="projects-title">Projects</h2></header>
          <div class="panel-body" id="projects"></div>
        </section>
        <section class="panel" aria-labelledby="baselines-title">
          <header><h2 id="baselines-title">Baselines</h2></header>
          <div class="panel-body" id="baselines"></div>
        </section>
        <section class="panel" aria-labelledby="diagnostics-title">
          <header><h2 id="diagnostics-title">System</h2></header>
          <div class="panel-body" id="diagnostics"></div>
        </section>
      </div>
    </aside>
    <main class="main" id="main" tabindex="-1">
      <section class="detail-header" aria-labelledby="current-run-title">
        <div>
          <h2 id="current-run-title">Runs</h2>
          <p id="current-run-subtitle">Final and historical QAgent runs</p>
        </div>
      </section>
      <section class="metrics" id="metrics" aria-label="Run metrics"></section>
      <section class="panel" aria-labelledby="runs-title">
        <header>
          <h2 id="runs-title">Recent Runs</h2>
          <div class="filters">
            <label>Project
              <select id="project-filter"></select>
            </label>
          </div>
        </header>
        <div class="panel-body" id="runs"></div>
      </section>
      <div class="tabs" role="tablist" aria-label="Run detail tabs">
        <button class="tab" type="button" role="tab" aria-selected="true" data-tab="results">Results</button>
        <button class="tab" type="button" role="tab" aria-selected="false" data-tab="findings">Findings</button>
        <button class="tab" type="button" role="tab" aria-selected="false" data-tab="evidence">Evidence</button>
        <button class="tab" type="button" role="tab" aria-selected="false" data-tab="pages">Pages</button>
      </div>
      <section class="panel tab-panel" id="tab-results" aria-labelledby="results-title">
        <header><h2 id="results-title">Results</h2></header>
        <div class="panel-body" id="results"></div>
      </section>
      <section class="panel tab-panel hidden" id="tab-findings" aria-labelledby="findings-title">
        <header>
          <h2 id="findings-title">Findings</h2>
          <div class="filters">
            <label>Severity
              <select id="severity-filter">
                <option value="">All</option>
                <option>Critical</option>
                <option>High</option>
                <option>Medium</option>
                <option>Low</option>
                <option>Info</option>
              </select>
            </label>
            <label>Category
              <input id="category-filter" type="search" autocomplete="off">
            </label>
          </div>
        </header>
        <div class="panel-body" id="findings"></div>
      </section>
      <section class="panel tab-panel hidden" id="tab-evidence" aria-labelledby="evidence-title">
        <header><h2 id="evidence-title">Evidence</h2></header>
        <div class="panel-body" id="evidence"></div>
      </section>
      <section class="panel tab-panel hidden" id="tab-pages" aria-labelledby="pages-title">
        <header><h2 id="pages-title">Pages</h2></header>
        <div class="panel-body" id="pages"></div>
      </section>
    </main>
  </div>
  <script>
    const state = {
      projects: [],
      runs: [],
      baselines: [],
      diagnostics: null,
      selectedProjectId: "",
      selectedRunId: "",
      report: null,
      activeTab: "results",
      severity: "",
      category: ""
    };

    const nodes = {
      projects: document.getElementById("projects"),
      baselines: document.getElementById("baselines"),
      diagnostics: document.getElementById("diagnostics"),
      runs: document.getElementById("runs"),
      metrics: document.getElementById("metrics"),
      results: document.getElementById("results"),
      findings: document.getElementById("findings"),
      evidence: document.getElementById("evidence"),
      pages: document.getElementById("pages"),
      projectFilter: document.getElementById("project-filter"),
      severityFilter: document.getElementById("severity-filter"),
      categoryFilter: document.getElementById("category-filter"),
      title: document.getElementById("current-run-title"),
      subtitle: document.getElementById("current-run-subtitle")
    };

    document.getElementById("refresh").addEventListener("click", () => loadDashboard());
    nodes.projectFilter.addEventListener("change", (event) => {
      state.selectedProjectId = event.target.value;
      loadRuns();
    });
    nodes.severityFilter.addEventListener("change", (event) => {
      state.severity = event.target.value;
      renderFindings();
    });
    nodes.categoryFilter.addEventListener("input", (event) => {
      state.category = event.target.value.trim().toLowerCase();
      renderFindings();
    });
    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeTab = button.dataset.tab;
        renderTabs();
      });
    });

    async function loadDashboard() {
      setLoading();
      try {
        const [projects, baselines, diagnostics] = await Promise.all([
          api("/api/v1/projects"),
          api("/api/v1/baselines"),
          api("/api/v1/system/diagnostics")
        ]);
        state.projects = projects;
        state.baselines = baselines;
        state.diagnostics = diagnostics;
        renderSidebar();
        await loadRuns();
      } catch (error) {
        renderError(nodes.runs, error);
      }
    }

    async function loadRuns() {
      const query = state.selectedProjectId ? "?projectId=" + encodeURIComponent(state.selectedProjectId) : "";
      state.runs = await api("/api/v1/runs" + query);
      renderRuns();
      if (state.runs.length > 0) {
        const selected = state.runs.find((run) => run.run.id === state.selectedRunId) || state.runs[0];
        await selectRun(selected.run.id);
      } else {
        state.selectedRunId = "";
        state.report = null;
        renderCurrentRun();
      }
    }

    async function selectRun(runId) {
      state.selectedRunId = runId;
      state.report = await api("/api/v1/runs/" + encodeURIComponent(runId) + "/report");
      renderCurrentRun();
      document.getElementById("main").focus();
    }

    async function api(path) {
      const response = await fetch(path, { headers: { accept: "application/json" } });
      const payload = await response.json();
      if (!payload.success) {
        throw new Error(payload.error ? payload.error.message : "Dashboard API error");
      }
      return payload.data;
    }

    function setLoading() {
      nodes.runs.textContent = "Loading";
      nodes.projects.textContent = "Loading";
      nodes.baselines.textContent = "Loading";
      nodes.diagnostics.textContent = "Loading";
    }

    function renderSidebar() {
      renderProjectFilter();
      renderProjects();
      renderBaselines();
      renderDiagnostics();
    }

    function renderProjectFilter() {
      clear(nodes.projectFilter);
      const all = document.createElement("option");
      all.value = "";
      all.textContent = "All projects";
      nodes.projectFilter.appendChild(all);
      for (const item of state.projects) {
        const option = document.createElement("option");
        option.value = item.project.id;
        option.textContent = item.project.name;
        nodes.projectFilter.appendChild(option);
      }
      nodes.projectFilter.value = state.selectedProjectId;
    }

    function renderProjects() {
      if (!state.projects.length) {
        renderEmpty(nodes.projects, "No projects");
        return;
      }
      renderTable(nodes.projects, ["Project", "Runs", "Latest"], state.projects.map((item) => [
        item.project.name,
        String(item.runCount),
        item.latestRun ? item.latestRun.status + " " + formatDate(item.latestRun.startedAt) : "No runs"
      ]));
    }

    function renderBaselines() {
      if (!state.baselines.length) {
        renderEmpty(nodes.baselines, "No baselines");
        return;
      }
      renderTable(nodes.baselines, ["Name", "Project", "Run"], state.baselines.slice(0, 8).map((item) => [
        item.name,
        item.projectName,
        item.runId
      ]), { monoColumns: [2] });
    }

    function renderDiagnostics() {
      const diagnostics = state.diagnostics;
      if (!diagnostics) {
        renderEmpty(nodes.diagnostics, "Unavailable");
        return;
      }
      renderTable(nodes.diagnostics, ["Check", "Value"], [
        ["Node", diagnostics.node],
        ["Database", diagnostics.database.exists ? "Available" : "Missing"],
        ["Mode", diagnostics.server.mode]
      ]);
    }

    function renderRuns() {
      if (!state.runs.length) {
        renderEmpty(nodes.runs, "No runs");
        return;
      }

      const table = createTable(["Run", "Project", "Status", "Started", "Findings"]);
      for (const item of state.runs) {
        const row = document.createElement("tr");
        row.appendChild(cell(runButton(item.run.id)));
        row.appendChild(cellText(item.project.name));
        row.appendChild(cell(statusBadge(item.run.status)));
        row.appendChild(cellText(formatDate(item.run.startedAt)));
        row.appendChild(cellText(String(item.findingCount)));
        table.querySelector("tbody").appendChild(row);
      }
      replace(nodes.runs, table);
    }

    function renderCurrentRun() {
      const report = state.report;
      if (!report) {
        nodes.title.textContent = "Runs";
        nodes.subtitle.textContent = "Final and historical QAgent runs";
        nodes.metrics.replaceChildren();
        renderEmpty(nodes.results, "No run selected");
        renderEmpty(nodes.findings, "No run selected");
        renderEmpty(nodes.evidence, "No run selected");
        renderEmpty(nodes.pages, "No run selected");
        return;
      }

      nodes.title.textContent = report.project.name;
      nodes.subtitle.textContent = report.run.id + " - " + (report.target.url || report.target.sourcePath || report.target.mode);
      renderMetrics(report.summary);
      renderResults();
      renderFindings();
      renderEvidence();
      renderPages();
      renderTabs();
    }

    function renderMetrics(summary) {
      nodes.metrics.replaceChildren(
        metric("Total", summary.total),
        metric("Pass", summary.pass),
        metric("Fail", summary.fail),
        metric("Error", summary.error),
        metric("Blocked", summary.blocked),
        metric("Skipped", summary.skipped)
      );
    }

    function renderResults() {
      const rows = state.report.results.map((result) => [
        result.testKey,
        result.layer,
        result.status,
        result.title,
        result.durationMs + " ms"
      ]);
      renderTable(nodes.results, ["Test", "Layer", "Status", "Title", "Duration"], rows, { statusColumns: [2], monoColumns: [0] });
    }

    function renderFindings() {
      if (!state.report) {
        renderEmpty(nodes.findings, "No run selected");
        return;
      }
      const findings = state.report.findings.filter((finding) => {
        if (state.severity && finding.severity !== state.severity) {
          return false;
        }
        if (state.category && !finding.category.toLowerCase().includes(state.category)) {
          return false;
        }
        return true;
      });
      if (!findings.length) {
        renderEmpty(nodes.findings, "No findings");
        return;
      }
      renderTable(nodes.findings, ["Severity", "Category", "Title", "Target", "Evidence"], findings.map((finding) => [
        finding.severity,
        finding.category,
        finding.title,
        finding.url || finding.endpoint || "",
        finding.evidenceRefs.map((item) => item.relativePath).join(", ")
      ]), { statusColumns: [0], monoColumns: [3, 4] });
    }

    function renderEvidence() {
      if (!state.report.evidence.length) {
        renderEmpty(nodes.evidence, "No evidence");
        return;
      }
      const table = createTable(["Type", "Path", "Size", "Open"]);
      for (const evidence of state.report.evidence) {
        const link = document.createElement("a");
        link.href = "/api/v1/evidence/" + encodeURIComponent(evidence.id);
        link.textContent = "Open";
        link.target = "_blank";
        link.rel = "noreferrer";
        const row = document.createElement("tr");
        row.appendChild(cellText(evidence.type));
        row.appendChild(cellText(evidence.relativePath, "mono"));
        row.appendChild(cellText(evidence.size ? String(evidence.size) : ""));
        row.appendChild(cell(link));
        table.querySelector("tbody").appendChild(row);
      }
      replace(nodes.evidence, table);
    }

    function renderPages() {
      if (!state.report.pages.length) {
        renderEmpty(nodes.pages, "No pages");
        return;
      }
      renderTable(nodes.pages, ["URL", "Status", "Title", "Links", "Forms"], state.report.pages.map((page) => [
        page.finalUrl || page.url,
        page.statusCode === undefined ? "" : String(page.statusCode),
        page.title || "",
        String(page.linkCount),
        String(page.formCount)
      ]), { monoColumns: [0] });
    }

    function renderTabs() {
      document.querySelectorAll(".tab").forEach((button) => {
        const selected = button.dataset.tab === state.activeTab;
        button.setAttribute("aria-selected", String(selected));
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("hidden", panel.id !== "tab-" + state.activeTab);
      });
    }

    function renderTable(target, headers, rows, options = {}) {
      const table = createTable(headers);
      for (const rowValues of rows) {
        const row = document.createElement("tr");
        rowValues.forEach((value, index) => {
          if ((options.statusColumns || []).includes(index)) {
            row.appendChild(cell(statusBadge(value)));
          } else {
            row.appendChild(cellText(value, (options.monoColumns || []).includes(index) ? "mono" : ""));
          }
        });
        table.querySelector("tbody").appendChild(row);
      }
      replace(target, table);
    }

    function createTable(headers) {
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const header of headers) {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = header;
        headerRow.appendChild(th);
      }
      const tbody = document.createElement("tbody");
      thead.appendChild(headerRow);
      table.append(thead, tbody);
      return table;
    }

    function statusBadge(value) {
      const span = document.createElement("span");
      span.className = "status status-" + String(value).toLowerCase();
      span.textContent = String(value);
      return span;
    }

    function runButton(runId) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "run-button mono";
      button.textContent = runId;
      button.addEventListener("click", () => selectRun(runId));
      return button;
    }

    function metric(label, value) {
      const div = document.createElement("div");
      div.className = "metric";
      const span = document.createElement("span");
      span.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      div.append(span, strong);
      return div;
    }

    function cellText(value, className = "") {
      const td = document.createElement("td");
      if (className) {
        td.className = className;
      }
      td.textContent = value === undefined || value === null ? "" : String(value);
      return td;
    }

    function cell(child) {
      const td = document.createElement("td");
      td.appendChild(child);
      return td;
    }

    function renderEmpty(target, text) {
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent = text;
      replace(target, div);
    }

    function renderError(target, error) {
      const div = document.createElement("div");
      div.className = "error";
      div.textContent = error.message || String(error);
      replace(target, div);
    }

    function clear(target) {
      target.replaceChildren();
    }

    function replace(target, child) {
      target.replaceChildren(child);
    }

    function formatDate(value) {
      return value ? new Date(value).toLocaleString() : "";
    }

    loadDashboard();
  </script>
</body>
</html>`;
}

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    settingsRef: row.settings_ref ?? undefined,
    createdAt: row.created_at
  };
}

function targetFromOverviewRow(row: RunOverviewRow): TargetRecord {
  return {
    id: row.target_id,
    projectId: row.project_id,
    mode: row.target_mode,
    url: row.target_url ?? undefined,
    sourcePath: row.target_source_path ?? undefined,
    environment: row.target_environment,
    allowedHosts: parseJson<string[]>(row.target_allowed_hosts_json) ?? [],
    createdAt: row.target_created_at
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
    toolVersions: parseJson<Record<string, string>>(row.tool_versions_json) ?? {},
    summary: parseJson<QualityGateSummary>(row.summary_json),
    artifactDir: row.artifact_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function runOverviewFromRow(row: RunOverviewRow): DashboardRunOverview {
  return {
    project: {
      id: row.project_id,
      name: row.project_name,
      settingsRef: row.project_settings_ref ?? undefined,
      createdAt: row.project_created_at
    },
    target: targetFromOverviewRow(row),
    run: runFromRow(row),
    resultCount: row.result_count,
    findingCount: row.finding_count,
    evidenceCount: row.evidence_count,
    failedResultCount: row.failed_result_count,
    criticalFindingCount: row.critical_finding_count
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
    tags: parseJson<string[]>(row.tags_json) ?? undefined,
    dependencies: parseJson<string[]>(row.dependencies_json) ?? undefined,
    error: row.error_text ?? undefined,
    expected: parseJson<unknown>(row.expected_json),
    actual: parseJson<unknown>(row.actual_json),
    evidenceRefs: parseJson<EvidenceRef[]>(row.evidence_refs_json) ?? [],
    findingRefs: parseJson<string[]>(row.finding_refs_json) ?? [],
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
    consoleErrors: parseJson<string[]>(row.console_errors_json) ?? [],
    networkErrors: parseJson<string[]>(row.network_errors_json) ?? [],
    discoveredAt: row.discovered_at
  };
}

function apiEndpointFromRow(row: ApiEndpointRow): ApiEndpoint {
  return {
    id: row.id,
    runId: row.run_id,
    method: row.method,
    normalizedPath: row.normalized_path,
    statusCodes: parseJson<number[]>(row.status_codes_json) ?? [],
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
    details: parseJson<Record<string, unknown>>(row.details_json),
    evidenceRefs: parseJson<EvidenceRef[]>(row.evidence_refs_json) ?? [],
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
    success: parseJson<AuthProfileReport["success"]>(row.success_json) ?? {},
    sessionArtifact: row.session_artifact ?? undefined
  };
}

function registeredTestFromRow(row: RegisteredTestRow): BrowserTestMetadata {
  return {
    key: row.key,
    title: row.title,
    layer: row.layer,
    tags: parseJson<string[]>(row.tags_json) ?? [],
    priority: row.priority,
    profile: row.profile ?? undefined,
    timeoutMs: row.timeout_ms,
    dependencies: parseJson<string[]>(row.dependencies_json) ?? []
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
    markers: parseJson<string[]>(row.markers_json) ?? [],
    adapterId: row.adapter_id,
    support: row.support,
    capabilities: parseJson<SourceProjectReport["capabilities"]>(row.capabilities_json) ?? [],
    inspectOnly: row.inspect_only === 1,
    reason: row.reason ?? undefined
  };
}

function sourceCommandFromRow(row: SourceCommandRow): SourceCommandReport {
  return {
    capability: row.capability,
    command: row.command,
    args: parseJson<string[]>(row.args_json) ?? [],
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

function emptySummary(): QualityGateSummary {
  return {
    passed: false,
    total: 0,
    pass: 0,
    fail: 0,
    error: 0,
    blocked: 0,
    skipped: 0,
    durationMs: 0
  };
}

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) {
    return undefined;
  }
  return JSON.parse(value) as T;
}

function searchValue(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null || value.trim() === "" ? undefined : value;
}

function numberSearchValue(url: URL, key: string): number | undefined {
  const value = searchValue(url, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pathSegments(pathname: string): string[] {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new DashboardApiError(400, "INVALID_PATH", "Request path contains invalid URL encoding.");
  }
}

function serverPort(server: Server, fallback: number): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : fallback;
}

function normalizeForPathCompare(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
