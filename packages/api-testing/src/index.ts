import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApiAssertionConfig, ApiAuthorizationCaseConfig, EvidenceRef, Finding, NormalizedResult, QAgentConfig, ResultStatus } from "#contracts";
import type { ApiTestAdapter, ApiTestOutput, ApiTestRequest } from "#core";
import { redactObject, redactText } from "#core";

const ADAPTER_ID = "api-http";
const ADAPTER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_DENY_STATUSES = [401, 403];
const SECRET_HEADER_KEYS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "api-key", "apikey"]);

interface ApiHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyForReport?: unknown;
  timeoutMs: number;
  secretValues: string[];
}

interface ApiHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

interface ApiExchange {
  startedAt: string;
  durationMs: number;
  request: ApiHttpRequest;
  response?: ApiHttpResponse;
  error?: string;
}

interface ExpectedStatuses {
  label: string;
  matches(status: number): boolean;
}

interface BuiltRequest {
  ok: true;
  request: ApiHttpRequest;
}

interface BlockedRequest {
  ok: false;
  reason: string;
  actual: unknown;
}

type RequestBuildResult = BuiltRequest | BlockedRequest;

export class HttpApiTestAdapter implements ApiTestAdapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;

  async runTests(request: ApiTestRequest): Promise<ApiTestOutput> {
    mkdirSync(request.artifactDir, { recursive: true });

    const results: NormalizedResult[] = [];
    const findings: Finding[] = [];
    const evidence: EvidenceRef[] = [];
    const wantsApi = request.config.tests.layers.includes("api");
    const wantsAuthorization = request.config.tests.layers.includes("authorization");

    if (wantsApi) {
      if (request.config.api.assertions.length === 0) {
        results.push(skippedResult({ request, layer: "api", testKey: "api.assertions.configured", title: "Configured API assertions", expected: "api.assertions entries", actual: "no API assertions configured" }));
      } else {
        for (const assertion of request.config.api.assertions) {
          const outcome = await this.executeAssertion(request, assertion);
          results.push(outcome.result);
          findings.push(...outcome.findings);
          evidence.push(...outcome.evidence);
        }
      }
    }

    if (wantsAuthorization) {
      if (request.config.api.authorization.length === 0) {
        results.push(
          skippedResult({
            request,
            layer: "authorization",
            testKey: "authorization.matrix.configured",
            title: "Configured RBAC permission matrix",
            expected: "api.authorization entries",
            actual: "no API authorization cases configured"
          })
        );
      } else {
        for (const authCase of request.config.api.authorization) {
          const outcomes = await this.executeAuthorizationCase(request, authCase);
          results.push(...outcomes.results);
          findings.push(...outcomes.findings);
          evidence.push(...outcomes.evidence);
        }
      }
    }

    return {
      results,
      findings: dedupeFindings(findings),
      evidence: dedupeEvidence(evidence)
    };
  }

  private async executeAssertion(
    request: ApiTestRequest,
    assertion: ApiAssertionConfig
  ): Promise<{ result: NormalizedResult; findings: Finding[]; evidence: EvidenceRef[] }> {
    const testKey = `api.${safeKey(assertion.key ?? `${assertion.method}.${assertion.path}.${assertion.profile ?? request.profile ?? "anonymous"}`)}`;
    const built = buildApiRequest({
      request,
      method: assertion.method,
      path: assertion.path,
      query: assertion.query,
      body: assertion.body,
      headers: assertion.headers,
      profileName: assertion.profile ?? request.profile,
      timeoutSeconds: assertion.timeout_seconds
    });

    if (!built.ok) {
      return {
        result: blockedResult({
          request,
          testKey,
          layer: "api",
          title: assertion.title ?? `API ${assertion.method} ${assertion.path}`,
          roleProfile: assertion.profile ?? request.profile,
          expected: "valid scoped API request",
          actual: built.actual,
          reason: built.reason
        }),
        findings: [],
        evidence: []
      };
    }

    const expected = expectedStatuses(assertion.expected_status, "success");
    const exchange = await performRequest(built.request);
    const actualStatus = exchange.response?.status;
    const status: ResultStatus = exchange.error ? "ERROR" : actualStatus !== undefined && expected.matches(actualStatus) ? "PASS" : "FAIL";
    const resultEvidence = maybeWriteExchangeEvidence({ request, testKey, status, exchange });
    const result = apiResult({
      request,
      testKey,
      layer: "api",
      title: assertion.title ?? `API ${assertion.method} ${assertion.path}`,
      roleProfile: assertion.profile ?? request.profile,
      status,
      startedAt: exchange.startedAt,
      durationMs: exchange.durationMs,
      targetRef: safeUrlForReport(built.request.url),
      expected: { status: expected.label },
      actual: exchangeActual(exchange),
      error: status === "PASS" ? undefined : exchange.error ?? `Expected ${expected.label}, received HTTP ${actualStatus ?? "none"}.`,
      evidenceRefs: resultEvidence
    });

    const findings =
      status === "FAIL"
        ? [
            createFinding({
              runId: request.runId,
              category: "api-assertion",
              severity: "Medium",
              title: "API assertion returned unexpected status",
              description: `Expected ${expected.label}, received HTTP ${actualStatus ?? "none"} for ${assertion.method} ${normalizeEndpointPath(built.request.url)}.`,
              url: safeUrlForReport(built.request.url),
              method: assertion.method,
              endpoint: normalizeEndpointPath(built.request.url),
              roleProfile: assertion.profile ?? request.profile,
              remediationHint: "Verify the configured API contract and target behavior.",
              evidenceRefs: resultEvidence
            })
          ]
        : [];

    return { result, findings, evidence: resultEvidence };
  }

  private async executeAuthorizationCase(
    request: ApiTestRequest,
    authCase: ApiAuthorizationCaseConfig
  ): Promise<{ results: NormalizedResult[]; findings: Finding[]; evidence: EvidenceRef[] }> {
    const permission = request.config.permissions[authCase.permission];
    const allowRoles = authCase.allow ?? permission?.allow ?? [];
    const denyRoles = authCase.deny ?? permission?.deny ?? [];
    const selectedRoles = request.profile ? new Set([request.profile]) : undefined;
    const roleCases = [
      ...allowRoles.map((profileName) => ({ profileName, expectation: "allow" as const })),
      ...denyRoles.map((profileName) => ({ profileName, expectation: "deny" as const }))
    ].filter((roleCase) => !selectedRoles || selectedRoles.has(roleCase.profileName));

    if (roleCases.length === 0) {
      const reason = request.profile
        ? `No API authorization case applies to profile '${request.profile}'.`
        : `No allow/deny roles configured for permission '${authCase.permission}'.`;
      return {
        results: [
          blockedResult({
            request,
            testKey: `authorization.${safeKey(authCase.key ?? authCase.permission)}.roles`,
            layer: "authorization",
            title: authCase.title ?? `RBAC ${authCase.permission}`,
            expected: "allow/deny role list",
            actual: { permission: authCase.permission, allow: allowRoles, deny: denyRoles },
            reason
          })
        ],
        findings: [],
        evidence: []
      };
    }

    const results: NormalizedResult[] = [];
    const findings: Finding[] = [];
    const evidence: EvidenceRef[] = [];

    for (const roleCase of roleCases) {
      const suffix = `${authCase.permission}.${roleCase.profileName}.${roleCase.expectation}`;
      const testKey = `authorization.${safeKey(authCase.key ? `${authCase.key}.${roleCase.profileName}.${roleCase.expectation}` : suffix)}`;
      const built = buildApiRequest({
        request,
        method: authCase.method,
        path: authCase.path,
        query: authCase.query,
        body: authCase.body,
        headers: authCase.headers,
        profileName: roleCase.profileName,
        timeoutSeconds: authCase.timeout_seconds
      });

      if (!built.ok) {
        results.push(
          blockedResult({
            request,
            testKey,
            layer: "authorization",
            title: authCase.title ?? `RBAC ${authCase.permission} ${roleCase.profileName}`,
            roleProfile: roleCase.profileName,
            expected: "valid scoped API request with role profile",
            actual: built.actual,
            reason: built.reason
          })
        );
        continue;
      }

      const expected = expectedStatuses(roleCase.expectation === "allow" ? authCase.allow_status : authCase.deny_status, roleCase.expectation);
      const exchange = await performRequest(built.request);
      const actualStatus = exchange.response?.status;
      const status: ResultStatus = exchange.error ? "ERROR" : actualStatus !== undefined && expected.matches(actualStatus) ? "PASS" : "FAIL";
      const resultEvidence = maybeWriteExchangeEvidence({ request, testKey, status, exchange });
      const result = apiResult({
        request,
        testKey,
        layer: "authorization",
        title: authCase.title ?? `RBAC ${authCase.permission} ${roleCase.profileName}`,
        roleProfile: roleCase.profileName,
        status,
        startedAt: exchange.startedAt,
        durationMs: exchange.durationMs,
        targetRef: safeUrlForReport(built.request.url),
        expected: {
          permission: authCase.permission,
          profile: roleCase.profileName,
          access: roleCase.expectation,
          status: expected.label
        },
        actual: exchangeActual(exchange),
        error: status === "PASS" ? undefined : exchange.error ?? `Expected ${expected.label}, received HTTP ${actualStatus ?? "none"}.`,
        evidenceRefs: resultEvidence
      });
      results.push(result);
      evidence.push(...resultEvidence);

      if (status === "FAIL" && roleCase.expectation === "deny" && actualStatus !== undefined && actualStatus >= 200 && actualStatus < 300) {
        findings.push(
          createFinding({
            runId: request.runId,
            category: "authorization-bypass",
            severity: "High",
            title: "Unauthorized role received successful API response",
            description: `${roleCase.profileName} was denied '${authCase.permission}' but received HTTP ${actualStatus} for ${authCase.method} ${normalizeEndpointPath(built.request.url)}.`,
            url: safeUrlForReport(built.request.url),
            method: authCase.method,
            endpoint: normalizeEndpointPath(built.request.url),
            roleProfile: roleCase.profileName,
            remediationHint: "Enforce server-side permission checks for this operation and add regression coverage.",
            evidenceRefs: resultEvidence
          })
        );
      }
    }

    return { results, findings, evidence };
  }
}

function buildApiRequest(input: {
  request: ApiTestRequest;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  headers?: Record<string, string>;
  profileName?: string;
  timeoutSeconds?: number;
}): RequestBuildResult {
  const baseUrl = input.request.config.api.base_url ?? input.request.url;
  const url = resolveApiUrl(baseUrl, input.path);
  if (!url.ok) {
    return url;
  }

  const scopeIssue = validateApiScope(input.request.config, url.url);
  if (scopeIssue) {
    return {
      ok: false,
      reason: scopeIssue,
      actual: { url: safeUrlForReport(url.url.toString()) }
    };
  }

  for (const [name, value] of Object.entries(input.query ?? {})) {
    url.url.searchParams.set(name, String(value));
  }

  const profileHeaders = input.profileName ? apiHeadersForProfile(input.request.config, input.profileName) : resolvedHeaders({}, input.request.config);
  const caseHeaders = resolvedHeaders(input.headers ?? {}, input.request.config);
  const issues = [...profileHeaders.issues, ...caseHeaders.issues];
  if (input.profileName && !input.request.config.auth.profiles[input.profileName]) {
    issues.push(`Auth profile '${input.profileName}' is not defined.`);
  }
  if (issues.length > 0) {
    return {
      ok: false,
      reason: issues.join(" "),
      actual: { profile: input.profileName, issues }
    };
  }

  const headers = { ...profileHeaders.headers, ...caseHeaders.headers };
  const body = serializeBody(input.body, headers);
  return {
    ok: true,
    request: {
      method: input.method.toUpperCase(),
      url: url.url.toString(),
      headers,
      body: body.wireBody,
      bodyForReport: body.bodyForReport,
      timeoutMs: Math.max(1, input.timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000,
      secretValues: [...profileHeaders.secretValues, ...caseHeaders.secretValues, ...collectSecretValues(input.request.config)]
    }
  };
}

function resolveApiUrl(baseUrl: string, path: string): { ok: true; url: URL } | BlockedRequest {
  try {
    const parsed = new URL(path, baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return {
        ok: false,
        reason: `API request URL scheme must be http or https: ${parsed.protocol}`,
        actual: { path }
      };
    }
    return { ok: true, url: parsed };
  } catch (error) {
    return {
      ok: false,
      reason: `Invalid API request URL: ${error instanceof Error ? error.message : String(error)}`,
      actual: { baseUrl, path }
    };
  }
}

function validateApiScope(config: QAgentConfig, url: URL): string | undefined {
  const allowedHosts = config.target.allowed_hosts ?? [];
  if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname)) {
    return `API request host '${url.hostname}' is outside allowed_hosts.`;
  }
  return undefined;
}

function apiHeadersForProfile(config: QAgentConfig, profileName: string): ReturnType<typeof resolvedHeaders> {
  const profile = config.auth.profiles[profileName];
  return resolvedHeaders(profile?.api?.headers ?? {}, config);
}

function resolvedHeaders(rawHeaders: Record<string, string>, config: QAgentConfig): { headers: Record<string, string>; secretValues: string[]; issues: string[] } {
  const headers: Record<string, string> = {};
  const secretValues: string[] = [];
  const issues: string[] = [];
  for (const [name, value] of Object.entries(rawHeaders)) {
    const resolution = resolveHeaderValue(name, value, config);
    if (!resolution.ok) {
      issues.push(resolution.reason);
      continue;
    }
    headers[name] = resolution.value;
    secretValues.push(...resolution.secretValues);
  }
  return { headers, secretValues, issues };
}

function resolveHeaderValue(
  headerName: string,
  value: string,
  config: QAgentConfig
): { ok: true; value: string; secretValues: string[] } | { ok: false; reason: string } {
  const envMatches = [...value.matchAll(/\$\{([A-Z0-9_]+)\}/gi)];
  if (envMatches.length === 0) {
    if (isSensitiveHeader(headerName, config)) {
      return { ok: false, reason: `Sensitive API header '${headerName}' must reference an environment variable.` };
    }
    return { ok: true, value, secretValues: [] };
  }

  const secretValues: string[] = [];
  let resolved = value;
  for (const match of envMatches) {
    const envName = match[1];
    const envValue = process.env[envName];
    if (!envValue) {
      return { ok: false, reason: `API header '${headerName}' references missing environment variable ${envName}.` };
    }
    resolved = resolved.split(match[0]).join(envValue);
    secretValues.push(envValue);
  }
  return { ok: true, value: resolved, secretValues };
}

function isSensitiveHeader(headerName: string, config: QAgentConfig): boolean {
  const key = headerName.toLowerCase();
  return SECRET_HEADER_KEYS.has(key) || config.report.redact_headers.map((item) => item.toLowerCase()).includes(key);
}

function serializeBody(body: unknown, headers: Record<string, string>): { wireBody?: string; bodyForReport?: unknown } {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body === "string") {
    return { wireBody: body, bodyForReport: body };
  }
  if (!hasHeader(headers, "content-type")) {
    headers["content-type"] = "application/json";
  }
  return { wireBody: JSON.stringify(body), bodyForReport: body };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === name.toLowerCase());
}

async function performRequest(request: ApiHttpRequest): Promise<ApiExchange> {
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });
    const responseBody = request.method === "HEAD" ? "" : await response.text();
    return {
      startedAt,
      durationMs: elapsedMs(startedAt, new Date().toISOString()),
      request,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody
      }
    };
  } catch (error) {
    const isTimeout = controller.signal.aborted;
    return {
      startedAt,
      durationMs: elapsedMs(startedAt, new Date().toISOString()),
      request,
      error: isTimeout ? `API_REQUEST_TIMEOUT after ${request.timeoutMs}ms` : String(error instanceof Error ? error.message : error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function expectedStatuses(input: number | number[] | undefined, kind: "success" | "allow" | "deny"): ExpectedStatuses {
  if (Array.isArray(input)) {
    const allowed = new Set(input);
    return { label: [...allowed].sort((left, right) => left - right).join(","), matches: (status) => allowed.has(status) };
  }
  if (typeof input === "number") {
    return { label: String(input), matches: (status) => status === input };
  }
  if (kind === "deny") {
    const allowed = new Set(DEFAULT_DENY_STATUSES);
    return { label: DEFAULT_DENY_STATUSES.join(","), matches: (status) => allowed.has(status) };
  }
  return { label: "2xx", matches: (status) => status >= 200 && status < 300 };
}

function maybeWriteExchangeEvidence(input: {
  request: ApiTestRequest;
  testKey: string;
  status: ResultStatus;
  exchange: ApiExchange;
}): EvidenceRef[] {
  const evidenceOn = input.request.config.report.evidence_on;
  const shouldCapture = evidenceOn === "always" || ((input.status === "FAIL" || input.status === "ERROR") && evidenceOn !== "never");
  if (!shouldCapture) {
    return [];
  }

  const relativePath = join("api", safeKey(input.testKey), "exchange.json");
  const absolutePath = join(input.request.artifactDir, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(exchangeForReport(input.exchange), null, 2)}\n`, "utf8");
  const content = readFileSync(absolutePath);
  return [
    {
      id: stableId(input.request.runId, relativePath),
      type: "json",
      relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength
    }
  ];
}

function exchangeForReport(exchange: ApiExchange): unknown {
  const secretValues = exchange.request.secretValues;
  return {
    startedAt: exchange.startedAt,
    durationMs: exchange.durationMs,
    request: {
      method: exchange.request.method,
      url: safeUrlForReport(exchange.request.url),
      headers: sanitizeObject(exchange.request.headers, secretValues),
      body: sanitizeObject(exchange.request.bodyForReport, secretValues)
    },
    response: exchange.response
      ? {
          status: exchange.response.status,
          statusText: exchange.response.statusText,
          headers: sanitizeObject(exchange.response.headers, secretValues),
          body: truncate(redactExact(redactText(exchange.response.body), secretValues))
        }
      : undefined,
    error: exchange.error ? redactExact(redactText(exchange.error), secretValues) : undefined
  };
}

function exchangeActual(exchange: ApiExchange): unknown {
  return exchangeForReport(exchange);
}

function sanitizeObject(input: unknown, secretValues: string[]): unknown {
  return redactExactInObject(redactObject(input), secretValues);
}

function redactExactInObject(input: unknown, secretValues: string[]): unknown {
  if (typeof input === "string") {
    return redactExact(input, secretValues);
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactExactInObject(item, secretValues));
  }
  if (!input || typeof input !== "object") {
    return input;
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, redactExactInObject(value, secretValues)]));
}

function redactExact(input: string, secretValues: string[]): string {
  let output = input;
  for (const secret of secretValues) {
    if (secret.length >= 3) {
      output = output.split(secret).join("<redacted>");
    }
  }
  return output;
}

function collectSecretValues(config: QAgentConfig): string[] {
  const values = new Set<string>();
  for (const profile of Object.values(config.auth.profiles)) {
    for (const raw of [profile.credentials.username, profile.credentials.password, ...Object.values(profile.api?.headers ?? {})]) {
      for (const match of raw.matchAll(/\$\{([A-Z0-9_]+)\}/gi)) {
        const resolved = process.env[match[1]];
        if (resolved) {
          values.add(resolved);
        }
      }
    }
  }
  return [...values];
}

function apiResult(input: {
  request: ApiTestRequest;
  testKey: string;
  layer: "api" | "authorization";
  title: string;
  roleProfile?: string;
  status: ResultStatus;
  startedAt: string;
  durationMs: number;
  targetRef: string;
  expected: unknown;
  actual: unknown;
  error?: string;
  evidenceRefs: EvidenceRef[];
}): NormalizedResult {
  return {
    id: randomUUID(),
    runId: input.request.runId,
    testKey: input.testKey,
    layer: input.layer,
    title: input.title,
    status: input.status,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    targetRef: input.targetRef,
    roleProfile: input.roleProfile,
    error: input.error ? redactText(input.error, input.request.config.report.redact_headers) : undefined,
    expected: input.expected,
    actual: input.actual,
    evidenceRefs: input.evidenceRefs,
    findingRefs: [],
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION
  };
}

function blockedResult(input: {
  request: ApiTestRequest;
  testKey: string;
  layer: "api" | "authorization";
  title: string;
  roleProfile?: string;
  expected: unknown;
  actual: unknown;
  reason: string;
}): NormalizedResult {
  return apiResult({
    request: input.request,
    testKey: input.testKey,
    layer: input.layer,
    title: input.title,
    roleProfile: input.roleProfile,
    status: "BLOCKED",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    targetRef: input.request.url,
    expected: input.expected,
    actual: input.actual,
    error: input.reason,
    evidenceRefs: []
  });
}

function skippedResult(input: {
  request: ApiTestRequest;
  layer: "api" | "authorization";
  testKey: string;
  title: string;
  expected: unknown;
  actual: unknown;
}): NormalizedResult {
  return apiResult({
    request: input.request,
    testKey: input.testKey,
    layer: input.layer,
    title: input.title,
    status: "SKIPPED",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    targetRef: input.request.url,
    expected: input.expected,
    actual: input.actual,
    evidenceRefs: []
  });
}

function createFinding(input: Omit<Finding, "id" | "fingerprint" | "evidenceRefs" | "redactionApplied"> & { runId: string; evidenceRefs?: EvidenceRef[] }): Finding {
  const fingerprint = createHash("sha256")
    .update([input.category, input.title, input.description, input.url ?? "", input.method ?? "", input.endpoint ?? "", input.roleProfile ?? ""].join("|"))
    .digest("hex")
    .slice(0, 16);

  return {
    id: stableId(input.runId, `finding:${fingerprint}`),
    fingerprint,
    category: input.category,
    severity: input.severity,
    title: input.title,
    description: redactText(input.description),
    url: input.url,
    method: input.method,
    endpoint: input.endpoint,
    roleProfile: input.roleProfile,
    remediationHint: input.remediationHint,
    evidenceRefs: input.evidenceRefs ?? [],
    redactionApplied: true
  };
}

function safeUrlForReport(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const query = [...url.searchParams.keys()].sort();
    return `${url.origin}${url.pathname}${query.length ? `?${query.map((key) => `${encodeURIComponent(key)}=<redacted>`).join("&")}` : ""}`;
  } catch {
    return redactText(rawUrl);
  }
}

function normalizeEndpointPath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return url.pathname || "/";
  } catch {
    return rawUrl.split("?")[0] || "/";
  }
}

function safeKey(input: string): string {
  return (
    input
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 120) || "api"
  );
}

function truncate(input: string): string {
  return input.length > 16_000 ? `${input.slice(0, 16_000)}\n<truncated>` : input;
}

function elapsedMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function stableId(runId: string, key: string): string {
  return `api_${createHash("sha256").update(`${runId}:${key}`).digest("hex").slice(0, 16)}`;
}

function dedupeEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  return [...new Map(evidence.map((item) => [item.id, item])).values()];
}

function dedupeFindings(findings: Finding[]): Finding[] {
  return [...new Map(findings.map((item) => [item.id, item])).values()];
}
