export const TARGET_ENVIRONMENTS = ["local", "development", "staging", "production"] as const;
export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number];

export const TARGET_MODES = ["cloud", "source"] as const;
export type TargetMode = (typeof TARGET_MODES)[number];

export const TEST_LAYERS = [
  "config",
  "source",
  "browser",
  "api",
  "authorization",
  "accessibility",
  "performance",
  "security",
  "load",
  "reporting"
] as const;
export type TestLayer = (typeof TEST_LAYERS)[number];

export const RUN_STATUSES = ["CREATED", "VALIDATING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export const RESULT_STATUSES = ["PASS", "FAIL", "BLOCKED", "SKIPPED", "ERROR"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const QUALITY_ADAPTER_CATEGORIES = ["accessibility", "performance", "security", "load"] as const;
export type QualityAdapterCategory = (typeof QUALITY_ADAPTER_CATEGORIES)[number];

export const ACCESSIBILITY_IMPACTS = ["critical", "serious", "moderate", "minor", "none"] as const;
export type AccessibilityImpact = (typeof ACCESSIBILITY_IMPACTS)[number];

export const EXIT_CODES = {
  ok: 0,
  qualityGateFailed: 1,
  configurationError: 2,
  runnerError: 3,
  unsafeOperation: 4,
  cancelled: 130
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface ProjectConfig {
  name: string;
}

export interface TargetConfig {
  environment: TargetEnvironment;
  url?: string;
  allowed_hosts?: string[];
}

export type SourceCommandName = "install" | "lint" | "typecheck" | "test" | "build" | "start";

export interface SourceCommandConfig {
  executable: string;
  args?: string[];
  timeout_seconds?: number;
}

export interface SourceHealthConfig {
  url?: string;
  timeout_seconds?: number;
}

export interface SourceConfig {
  adapter?: string;
  fallback_to_cloud?: boolean;
  commands?: Partial<Record<SourceCommandName, SourceCommandConfig>>;
  health?: SourceHealthConfig;
}

export const SOURCE_CAPABILITIES = ["detect", "inspect", "install", "lint", "typeCheck", "test", "build", "start", "healthCheck", "stop"] as const;
export type SourceCapabilityName = (typeof SOURCE_CAPABILITIES)[number];

export const CAPABILITY_STATES = ["SUPPORTED", "UNAVAILABLE", "DISABLED", "NOT_APPLICABLE"] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export const RUNTIME_SUPPORT_STATES = ["SUPPORTED", "LIMITED", "UNSUPPORTED", "PLANNED"] as const;
export type RuntimeSupportState = (typeof RUNTIME_SUPPORT_STATES)[number];

export interface SourceCommandDescriptor {
  capability: SourceCapabilityName;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface SourceCapabilityReport {
  name: SourceCapabilityName;
  state: CapabilityState;
  reason?: string;
  command?: SourceCommandDescriptor;
}

export interface SourceProjectReport {
  path: string;
  runtime: string;
  framework: string;
  confidence: "high" | "medium" | "low" | "none";
  runtimeVersion?: string;
  packageManager?: string;
  markers: string[];
  adapterId: string;
  support: RuntimeSupportState;
  capabilities: SourceCapabilityReport[];
  inspectOnly: boolean;
  reason?: string;
}

export interface SourceCommandReport {
  capability: SourceCapabilityName;
  command: string;
  args: string[];
  cwd: string;
  exitCode?: number;
  durationMs: number;
  status: ResultStatus;
  startedAt: string;
  stdoutArtifact?: string;
  stderrArtifact?: string;
  reason?: string;
}

export interface SafetyConfig {
  destructive: boolean;
  active_security_scan: boolean;
  load_test: boolean;
  max_concurrency: number;
  allow_source_commands: boolean;
  confirmation_token?: string;
}

export interface AuthProfileConfig {
  loginUrl: string;
  credentials: {
    username: string;
    password: string;
  };
  selectors: {
    username: string;
    password: string;
    submit: string;
  };
  success: {
    urlContains?: string;
    selector?: string;
  };
  api?: {
    headers?: Record<string, string>;
  };
}

export interface AuthConfig {
  profiles: Record<string, AuthProfileConfig>;
}

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type ExpectedStatusConfig = number | number[];

export interface ApiAssertionConfig {
  key?: string;
  title?: string;
  method: HttpMethod;
  path: string;
  profile?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  expected_status?: ExpectedStatusConfig;
  timeout_seconds?: number;
}

export interface ApiAuthorizationCaseConfig {
  key?: string;
  title?: string;
  permission: string;
  method: HttpMethod;
  path: string;
  allow?: string[];
  deny?: string[];
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  allow_status?: ExpectedStatusConfig;
  deny_status?: ExpectedStatusConfig;
  timeout_seconds?: number;
}

export interface ApiConfig {
  base_url?: string;
  assertions: ApiAssertionConfig[];
  authorization: ApiAuthorizationCaseConfig[];
  openapi?: {
    path?: string;
    url?: string;
  };
}

export interface AccessibilityConfig {
  enabled: boolean;
  engine: "axe";
  failOn: AccessibilityImpact[];
  maxViolations: Partial<Record<AccessibilityImpact, number>>;
  include?: string[];
  exclude: string[];
  maxPages: number;
  profiles: string[];
  timeout_seconds: number;
  maxNodesPerRule: number;
}

export interface PerformanceThresholdsConfig {
  maxFirstByteMs?: number;
  maxDomContentLoadedMs?: number;
  maxLoadEventMs?: number;
  maxTransferSizeBytes?: number;
  maxResourceCount?: number;
}

export interface PerformanceConfig {
  enabled: boolean;
  engine: "browser-timing";
  include?: string[];
  exclude: string[];
  maxPages: number;
  timeout_seconds: number;
  waitUntil: "domcontentloaded" | "load" | "networkidle";
  thresholds: PerformanceThresholdsConfig;
}

export const SECURITY_CHECKS = [
  "content-security-policy",
  "frame-protection",
  "x-content-type-options",
  "referrer-policy",
  "strict-transport-security",
  "cookie-http-only",
  "cookie-secure",
  "cookie-same-site"
] as const;
export type SecurityCheckKey = (typeof SECURITY_CHECKS)[number];

export interface SecurityConfig {
  enabled: boolean;
  engine: "passive-http";
  failOn: SecurityCheckKey[];
  include?: string[];
  exclude: string[];
  maxPages: number;
  timeout_seconds: number;
  checks: Partial<Record<SecurityCheckKey, boolean>>;
}

export interface LoadThresholdsConfig {
  maxErrorRate?: number;
  maxAverageMs?: number;
  maxP95Ms?: number;
}

export interface LoadConfig {
  enabled: boolean;
  engine: "http-smoke";
  include?: string[];
  exclude: string[];
  maxPages: number;
  timeout_seconds: number;
  requestsPerTarget: number;
  concurrency: number;
  thresholds: LoadThresholdsConfig;
}

export interface DiscoveryConfig {
  max_pages: number;
  max_depth: number;
  same_origin_only: boolean;
  exclude: string[];
}

export interface TestsConfig {
  layers: TestLayer[];
  retries: number;
}

export interface PermissionRule {
  allow?: string[];
  deny?: string[];
}

export interface ReportConfig {
  formats: Array<"html" | "json" | "junit" | "xlsx">;
  evidence_on: "failure" | "always" | "never";
  redact_headers: string[];
}

export interface QAgentConfig {
  project: ProjectConfig;
  target: TargetConfig;
  source?: SourceConfig;
  safety: SafetyConfig;
  auth: AuthConfig;
  api: ApiConfig;
  accessibility: AccessibilityConfig;
  performance: PerformanceConfig;
  security: SecurityConfig;
  load: LoadConfig;
  discovery: DiscoveryConfig;
  tests: TestsConfig;
  permissions: Record<string, PermissionRule>;
  report: ReportConfig;
}

export interface ProjectRecord {
  id: string;
  name: string;
  settingsRef?: string;
  createdAt: string;
}

export interface TargetRecord {
  id: string;
  projectId: string;
  mode: TargetMode;
  url?: string;
  sourcePath?: string;
  environment: TargetEnvironment;
  allowedHosts: string[];
  createdAt: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  targetId: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  toolVersions: Record<string, string>;
  summary?: QualityGateSummary;
  artifactDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceRef {
  id: string;
  type: "screenshot" | "trace" | "video" | "log" | "json" | "html" | "junit" | "other";
  relativePath: string;
  sha256?: string;
  size?: number;
}

export interface DiscoveredPage {
  id: string;
  runId: string;
  url: string;
  normalizedUrl: string;
  finalUrl?: string;
  statusCode?: number;
  title?: string;
  linkCount: number;
  formCount: number;
  buttonCount: number;
  redirectCount: number;
  consoleErrors: string[];
  networkErrors: string[];
  discoveredAt: string;
}

export interface ApiEndpoint {
  id: string;
  runId: string;
  method: string;
  normalizedPath: string;
  statusCodes: number[];
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface Finding {
  id: string;
  fingerprint: string;
  category: string;
  severity: "Critical" | "High" | "Medium" | "Low" | "Info";
  title: string;
  description: string;
  url?: string;
  method?: string;
  endpoint?: string;
  roleProfile?: string;
  remediationHint?: string;
  details?: Record<string, unknown>;
  evidenceRefs: EvidenceRef[];
  redactionApplied: boolean;
}

export type BrowserTestPriority = "P0" | "P1" | "P2" | "P3";

export interface BrowserTestMetadata {
  key: string;
  title: string;
  layer: "browser";
  tags: string[];
  priority: BrowserTestPriority;
  profile?: string;
  timeoutMs: number;
  dependencies: string[];
}

export interface AuthProfileReport {
  name: string;
  loginUrl: string;
  usernameRef: string;
  success: AuthProfileConfig["success"];
  sessionArtifact?: string;
}

export interface NormalizedResult {
  id: string;
  runId: string;
  testKey: string;
  layer: TestLayer;
  title: string;
  status: ResultStatus;
  startedAt: string;
  durationMs: number;
  targetRef: string;
  roleProfile?: string;
  priority?: BrowserTestPriority;
  tags?: string[];
  dependencies?: string[];
  error?: string;
  expected?: unknown;
  actual?: unknown;
  evidenceRefs: EvidenceRef[];
  findingRefs: string[];
  adapterId: string;
  adapterVersion: string;
}

export interface QualityGateSummary {
  passed: boolean;
  total: number;
  pass: number;
  fail: number;
  error: number;
  blocked: number;
  skipped: number;
  durationMs: number;
}

export interface RunReportData {
  project: ProjectRecord;
  target: TargetRecord;
  run: RunRecord;
  sourceProject?: SourceProjectReport;
  sourceCommands: SourceCommandReport[];
  pages: DiscoveredPage[];
  apiEndpoints: ApiEndpoint[];
  authProfiles: AuthProfileReport[];
  registeredTests: BrowserTestMetadata[];
  results: NormalizedResult[];
  findings: Finding[];
  evidence: EvidenceRef[];
  summary: QualityGateSummary;
}

export interface ReportOutput {
  runId: string;
  rootDir: string;
  jsonPath?: string;
  htmlPath?: string;
  junitPath?: string;
  xlsxPath?: string;
}

export interface BaselineRecord {
  id: string;
  projectId: string;
  runId: string;
  name: string;
  createdAt: string;
}

export const REGRESSION_CLASSIFICATIONS = [
  "unchanged",
  "unchanged-failure",
  "new-failure",
  "resolved-failure",
  "status-changed",
  "added-test",
  "missing-test"
] as const;
export type RegressionClassification = (typeof REGRESSION_CLASSIFICATIONS)[number];

export interface RegressionComparisonEntry {
  testKey: string;
  title: string;
  layer?: TestLayer;
  roleProfile?: string;
  baselineResultId?: string;
  currentResultId?: string;
  baselineStatus?: ResultStatus;
  currentStatus?: ResultStatus;
  baselineError?: string;
  currentError?: string;
  classification: RegressionClassification;
}

export const REGRESSION_FINDING_CLASSIFICATIONS = ["unchanged-finding", "new-finding", "resolved-finding", "finding-changed"] as const;
export type RegressionFindingClassification = (typeof REGRESSION_FINDING_CLASSIFICATIONS)[number];

export interface RegressionFindingComparisonEntry {
  fingerprint: string;
  category: string;
  title: string;
  baselineFindingId?: string;
  currentFindingId?: string;
  baselineSeverity?: Finding["severity"];
  currentSeverity?: Finding["severity"];
  baselineTarget?: string;
  currentTarget?: string;
  classification: RegressionFindingClassification;
}

export interface RegressionComparisonSummary {
  passed: boolean;
  baselineTotal: number;
  currentTotal: number;
  comparedTotal: number;
  unchanged: number;
  unchangedFailures: number;
  newFailures: number;
  resolvedFailures: number;
  statusChanged: number;
  addedTests: number;
  missingTests: number;
  unchangedFindings: number;
  newFindings: number;
  resolvedFindings: number;
  changedFindings: number;
  regressions: number;
  improvements: number;
}

export interface RegressionComparison {
  id: string;
  project: ProjectRecord;
  baseline: BaselineRecord;
  baselineRun: RunRecord;
  currentRun: RunRecord;
  comparedAt: string;
  summary: RegressionComparisonSummary;
  entries: RegressionComparisonEntry[];
  findingEntries: RegressionFindingComparisonEntry[];
}

export interface ComparisonReportOutput {
  comparisonId: string;
  rootDir: string;
  jsonPath?: string;
  htmlPath?: string;
  xlsxPath?: string;
}

export interface RuntimeCapability {
  name: string;
  supported: boolean;
  state?: CapabilityState;
  reason?: string;
  command?: SourceCommandDescriptor;
}

export interface DetectionResult {
  adapterId: string;
  confidence: "high" | "medium" | "low" | "none";
  status: RuntimeSupportState;
  runtime?: string;
  framework?: string;
  packageManager?: string;
  manifests: string[];
  markers?: string[];
  capabilities: RuntimeCapability[];
  reason?: string;
}

export interface StepResult {
  name: string;
  status: ResultStatus;
  startedAt: string;
  durationMs: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}
