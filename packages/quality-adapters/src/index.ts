import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import axe from "axe-core";
import { chromium } from "playwright";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { resolveAuthProfile } from "#config";
import type {
  AccessibilityConfig,
  AccessibilityImpact,
  DiscoveredPage,
  EvidenceRef,
  Finding,
  LoadConfig,
  NormalizedResult,
  PerformanceConfig,
  QAgentConfig,
  ResultStatus,
  SecurityCheckKey,
  SecurityConfig
} from "#contracts";
import type { QualityAdapter, QualityAdapterAvailability, QualityAdapterOutput, QualityAdapterRequest } from "#core";
import { redactObject, redactText } from "#core";
import { PlaywrightAuthActionsImpl, safeUrlForReport, sessionStatePath } from "#browser-playwright";

const ADAPTER_ID = "axe-accessibility";
const ADAPTER_VERSION = "0.1.0";
const PERFORMANCE_ADAPTER_ID = "browser-performance";
const PERFORMANCE_ADAPTER_VERSION = "0.1.0";
const SECURITY_ADAPTER_ID = "passive-security";
const SECURITY_ADAPTER_VERSION = "0.1.0";
const LOAD_ADAPTER_ID = "http-load-smoke";
const LOAD_ADAPTER_VERSION = "0.1.0";
const USER_AGENT = "QAgent/0.1.0 Accessibility Scanner";
const PERFORMANCE_USER_AGENT = "QAgent/0.1.0 Performance Scanner";
const SECURITY_USER_AGENT = "QAgent/0.1.0 Passive Security Scanner";
const LOAD_USER_AGENT = "QAgent/0.1.0 Load Smoke Scanner";
const DEFAULT_MAX_HTML_SNIPPET = 1000;

export interface QualityAdapterRegistration {
  id: string;
}

export interface NormalizedAccessibilityViolation {
  fingerprint: string;
  ruleId: string;
  impact: AccessibilityImpact;
  severity: Finding["severity"];
  description: string;
  help: string;
  helpUrl: string;
  pageUrl: string;
  target: string;
  html: string;
  failureSummary: string;
}

export interface AccessibilityGateResult {
  passed: boolean;
  counts: Record<AccessibilityImpact, number>;
  breaches: Array<{ impact: AccessibilityImpact; count: number; limit: number }>;
}

export interface BrowserTimingMeasurement {
  pageUrl: string;
  firstByteMs: number;
  domContentLoadedMs: number;
  loadEventMs: number;
  transferSizeBytes: number;
  encodedBodySizeBytes: number;
  decodedBodySizeBytes: number;
  resourceCount: number;
  resourceTransferSizeBytes: number;
}

export interface PerformanceGateResult {
  passed: boolean;
  breaches: PerformanceThresholdBreach[];
}

export interface PerformanceThresholdBreach {
  metric: keyof PerformanceConfig["thresholds"];
  actual: number;
  threshold: number;
}

export interface PassiveSecurityObservation {
  pageUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  cookies: PassiveSecurityCookie[];
  issues: PassiveSecurityIssue[];
}

export interface PassiveSecurityCookie {
  name: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

export interface PassiveSecurityIssue {
  check: SecurityCheckKey;
  severity: Finding["severity"];
  title: string;
  description: string;
  remediationHint: string;
  evidence: Record<string, unknown>;
}

export interface SecurityGateResult {
  passed: boolean;
  breaches: PassiveSecurityIssue[];
}

export interface LoadSample {
  statusCode?: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface LoadMeasurement {
  pageUrl: string;
  totalRequests: number;
  failedRequests: number;
  errorRate: number;
  averageMs: number;
  p95Ms: number;
  samples: LoadSample[];
}

export interface LoadGateResult {
  passed: boolean;
  breaches: LoadThresholdBreach[];
}

export interface LoadThresholdBreach {
  metric: keyof LoadConfig["thresholds"];
  actual: number;
  threshold: number;
}

interface SelectedTarget {
  url: string;
  label: string;
}

interface PageScanOutput {
  result: NormalizedResult;
  findings: Finding[];
  violations: NormalizedAccessibilityViolation[];
}

interface AxeAccessibilityAdapterOptions {
  headless?: boolean;
  axeSource?: string;
  unavailableReason?: string;
}

interface BrowserPerformanceAdapterOptions {
  headless?: boolean;
  unavailableReason?: string;
}

interface PassiveSecurityAdapterOptions {
  unavailableReason?: string;
  fetchResponse?: (url: string, timeoutMs: number) => Promise<PassiveSecurityHttpResponse>;
}

interface HttpLoadSmokeAdapterOptions {
  unavailableReason?: string;
  fetchSample?: (url: string, timeoutMs: number) => Promise<LoadSample>;
}

export interface PassiveSecurityHttpResponse {
  pageUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  setCookie: string[];
}

type AxeResult = axe.Result;
type AxeNodeResult = axe.NodeResult;
type AxeResults = axe.AxeResults;

export class QualityAdapterRegistry {
  private readonly adapters = new Map<string, QualityAdapter>();

  constructor(adapters: QualityAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: QualityAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Duplicate quality adapter id '${adapter.id}'.`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): QualityAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): QualityAdapter[] {
    return [...this.adapters.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  byCategory(category: QualityAdapter["category"]): QualityAdapter[] {
    return this.list().filter((adapter) => adapter.category === category);
  }
}

export function defaultQualityAdapterRegistry(): QualityAdapterRegistry {
  return new QualityAdapterRegistry([new AxeAccessibilityAdapter(), new BrowserPerformanceAdapter(), new HttpLoadSmokeAdapter(), new PassiveSecurityAdapter()]);
}

export class AxeAccessibilityAdapter implements QualityAdapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;
  readonly category = "accessibility" as const;
  readonly capabilities = ["axe", "public-pages", "authenticated-pages", "bounded-evidence"];

  constructor(private readonly options: AxeAccessibilityAdapterOptions = {}) {}

  availability(): QualityAdapterAvailability {
    if (this.options.unavailableReason) {
      return { status: "UNAVAILABLE", reason: this.options.unavailableReason };
    }
    if (!this.axeSource()) {
      return { status: "UNAVAILABLE", reason: "axe-core source is unavailable" };
    }
    return { status: "SUPPORTED" };
  }

  async execute(request: QualityAdapterRequest): Promise<QualityAdapterOutput> {
    const config = request.config.accessibility;
    if (!config.enabled) {
      return {
        results: [
          adapterResult({
            request,
            testKey: "accessibility.axe.enabled",
            title: "Axe accessibility adapter enabled",
            status: "SKIPPED",
            startedAt: now(),
            durationMs: 0,
            targetRef: request.url,
            expected: "accessibility.enabled: true",
            actual: "accessibility disabled by config",
            evidenceRefs: []
          })
        ],
        findings: [],
        evidence: []
      };
    }

    const availability = this.availability();
    if (availability.status !== "SUPPORTED") {
      return {
        results: [
          adapterResult({
            request,
            testKey: "accessibility.axe.available",
            title: "Axe accessibility adapter availability",
            status: "BLOCKED",
            startedAt: now(),
            durationMs: 0,
            targetRef: request.url,
            expected: "axe-core available",
            actual: availability.reason ?? "unavailable",
            error: availability.reason ?? "unavailable",
            evidenceRefs: []
          })
        ],
        findings: [],
        evidence: []
      };
    }

    const results: NormalizedResult[] = [
      adapterResult({
        request,
        testKey: "accessibility.axe.adapter",
        title: "Axe accessibility adapter execution health",
        status: "PASS",
        startedAt: now(),
        durationMs: 0,
        targetRef: request.url,
        expected: "axe-core loaded without scanning target quality",
        actual: { engine: "axe-core", version: axe.version, capabilities: this.capabilities },
        evidenceRefs: []
      })
    ];
    const pageOutputs: PageScanOutput[] = [];
    const maxPages = Math.max(1, config.maxPages);
    let remaining = maxPages;

    const publicTargets = selectAccessibilityTargets({
      config: request.config,
      baseUrl: request.url,
      discoveredPages: request.discoveredPages,
      profileName: "public",
      maxPages: remaining
    });
    remaining -= publicTargets.length;

    const profileNames = selectedProfiles(request);
    const browser = await chromium.launch({ headless: this.options.headless ?? true });
    try {
      pageOutputs.push(...(await this.scanPublicTargets({ browser, request, targets: publicTargets })));

      for (const profileName of profileNames) {
        if (remaining <= 0) {
          break;
        }
        const profileTargets = selectAccessibilityTargets({
          config: request.config,
          baseUrl: request.url,
          discoveredPages: [],
          profileName,
          maxPages: remaining
        });
        remaining -= profileTargets.length;
        pageOutputs.push(...(await this.scanAuthenticatedTargets({ browser, request, profileName, targets: profileTargets })));
      }
    } finally {
      await browser.close();
    }

    if (publicTargets.length === 0 && profileNames.length === 0) {
      results.push(
        adapterResult({
          request,
          testKey: "accessibility.axe.targets",
          title: "Axe accessibility scan targets",
          status: "SKIPPED",
          startedAt: now(),
          durationMs: 0,
          targetRef: request.url,
          expected: "at least one eligible accessibility target",
          actual: "no eligible target URL found",
          evidenceRefs: []
        })
      );
    }

    const violations = pageOutputs.flatMap((output) => output.violations);
    const evidence = maybeWriteAccessibilityEvidence({ request, violations, outputs: pageOutputs });
    const findings = dedupeFindings(
      pageOutputs
        .flatMap((output) => output.findings)
        .map((finding) => ({
          ...finding,
          evidenceRefs: evidence
        }))
    );
    const findingIds = new Set(findings.map((finding) => finding.id));
    results.push(
      ...pageOutputs.map((output) => ({
        ...output.result,
        findingRefs: output.result.findingRefs.filter((id) => findingIds.has(id)),
        evidenceRefs: shouldAttachEvidence(output.result, evidence) ? evidence : output.result.evidenceRefs
      }))
    );

    return {
      results,
      findings,
      evidence
    };
  }

  private async scanPublicTargets(input: { browser: Browser; request: QualityAdapterRequest; targets: SelectedTarget[] }): Promise<PageScanOutput[]> {
    if (input.targets.length === 0) {
      return [];
    }

    const context = await input.browser.newContext({ userAgent: USER_AGENT });
    try {
      const outputs: PageScanOutput[] = [];
      for (const target of input.targets) {
        outputs.push(await this.scanTarget({ request: input.request, context, target, scope: "public" }));
      }
      return outputs;
    } finally {
      await context.close();
    }
  }

  private async scanAuthenticatedTargets(input: {
    browser: Browser;
    request: QualityAdapterRequest;
    profileName: string;
    targets: SelectedTarget[];
  }): Promise<PageScanOutput[]> {
    if (input.targets.length === 0) {
      return [];
    }

    const contextOptions: BrowserContextOptions = { userAgent: USER_AGENT };
    const storagePath = sessionStatePath(input.request.sessionRoot, input.request.url, input.profileName);
    if (existsSync(storagePath)) {
      contextOptions.storageState = storagePath;
    }

    const context = await input.browser.newContext(contextOptions);
    const page = await context.newPage();
    try {
      const secretValues = secretValuesForProfile(input.request.config, input.profileName);
      if (!existsSync(storagePath)) {
        const auth = new PlaywrightAuthActionsImpl({
          config: input.request.config,
          baseUrl: input.request.url,
          sessionRoot: input.request.sessionRoot,
          context,
          page
        });
        const startedAt = now();
        try {
          const authResult = await auth.login(input.profileName, { expectSuccess: true, saveSession: true, timeoutMs: input.request.config.accessibility.timeout_seconds * 1000 });
          if (authResult.status !== "PASS") {
            return input.targets.map((target) =>
              blockedScan({
                request: input.request,
                target,
                scope: input.profileName,
                startedAt,
                reason: authResult.reason ?? "Authentication did not pass.",
                actual: authResult.actual,
                secretValues
              })
            );
          }
        } catch (error) {
          return input.targets.map((target) =>
            blockedScan({
              request: input.request,
              target,
              scope: input.profileName,
              startedAt,
              reason: sanitizeText(error instanceof Error ? error.message : String(error), input.request.config.report.redact_headers, secretValues),
              actual: { profile: input.profileName, error: sanitizeText(error instanceof Error ? error.message : String(error), input.request.config.report.redact_headers, secretValues) },
              secretValues
            })
          );
        }
      }

      const outputs: PageScanOutput[] = [];
      for (const target of input.targets) {
        outputs.push(await this.scanTarget({ request: input.request, context, target, scope: input.profileName, secretValues }));
      }
      return outputs;
    } finally {
      await context.close();
    }
  }

  private async scanTarget(input: {
    request: QualityAdapterRequest;
    context: BrowserContext;
    target: SelectedTarget;
    scope: string;
    secretValues?: string[];
  }): Promise<PageScanOutput> {
    const startedAt = now();
    const page = await input.context.newPage();
    const secretValues = input.secretValues ?? [];

    try {
      await page.goto(input.target.url, { waitUntil: "domcontentloaded", timeout: input.request.config.accessibility.timeout_seconds * 1000 });
      await page.waitForLoadState("networkidle", { timeout: Math.min(input.request.config.accessibility.timeout_seconds * 1000, 1000) }).catch(() => undefined);
      const axeResults = await this.runAxe(page, input.request.config.accessibility.timeout_seconds * 1000);
      const pageUrl = safeUrlForReport(page.url());
      const violations = normalizeAxeResults({
        raw: axeResults,
        pageUrl,
        config: input.request.config.accessibility,
        redactHeaders: input.request.config.report.redact_headers,
        secretValues
      });
      const gate = evaluateAccessibilityGate(violations, input.request.config.accessibility);
      const findings = violations.map((violation) => accessibilityFinding({ request: input.request, violation }));
      const result = adapterResult({
        request: input.request,
        testKey: accessibilityTestKey(input.scope, input.target.url),
        title: `Axe accessibility scan ${input.scope} ${input.target.label}`,
        roleProfile: input.scope === "public" ? undefined : input.scope,
        status: gate.passed ? "PASS" : "FAIL",
        startedAt,
        durationMs: elapsedMs(startedAt, now()),
        targetRef: pageUrl,
        expected: {
          failOn: input.request.config.accessibility.failOn,
          maxViolations: input.request.config.accessibility.maxViolations
        },
        actual: {
          page: pageUrl,
          scope: input.scope,
          violations: violations.length,
          counts: gate.counts,
          breaches: gate.breaches
        },
        error: gate.passed ? undefined : gate.breaches.map((breach) => `${breach.impact}=${breach.count} limit=${breach.limit}`).join(", "),
        evidenceRefs: [],
        findingRefs: findings.map((finding) => finding.id)
      });
      return { result, findings, violations };
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : String(error), input.request.config.report.redact_headers, secretValues);
      return {
        result: adapterResult({
          request: input.request,
          testKey: accessibilityTestKey(input.scope, input.target.url),
          title: `Axe accessibility scan ${input.scope} ${input.target.label}`,
          roleProfile: input.scope === "public" ? undefined : input.scope,
          status: "ERROR",
          startedAt,
          durationMs: elapsedMs(startedAt, now()),
          targetRef: safeUrlForReport(input.target.url),
          expected: "page navigates and axe completes",
          actual: { error: message },
          error: message,
          evidenceRefs: []
        }),
        findings: [],
        violations: []
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async runAxe(page: Page, timeoutMs: number): Promise<AxeResults> {
    await page.addScriptTag({ content: this.axeSource() });
    return withTimeout(
      page.evaluate(async () => {
        const axeRuntime = (globalThis as unknown as { axe?: { run: (context?: unknown, options?: unknown) => Promise<unknown> } }).axe;
        if (!axeRuntime) {
          throw new Error("axe runtime was not injected");
        }
        return axeRuntime.run((globalThis as unknown as { document: unknown }).document, {
          resultTypes: ["violations"],
          iframes: false,
          selectors: true,
          ancestry: false,
          xpath: false,
          absolutePaths: false
        });
      }) as Promise<AxeResults>,
      timeoutMs,
      "axe scan"
    );
  }

  private axeSource(): string {
    return this.options.axeSource ?? axe.source;
  }
}

export class BrowserPerformanceAdapter implements QualityAdapter {
  readonly id = PERFORMANCE_ADAPTER_ID;
  readonly version = PERFORMANCE_ADAPTER_VERSION;
  readonly category = "performance" as const;
  readonly capabilities = ["browser-timing", "navigation-timing", "resource-summary", "public-pages", "bounded-evidence"];

  constructor(private readonly options: BrowserPerformanceAdapterOptions = {}) {}

  availability(): QualityAdapterAvailability {
    if (this.options.unavailableReason) {
      return { status: "UNAVAILABLE", reason: this.options.unavailableReason };
    }
    try {
      chromium.executablePath();
      return { status: "SUPPORTED" };
    } catch (error) {
      return { status: "UNAVAILABLE", reason: error instanceof Error ? error.message : "Playwright Chromium is unavailable" };
    }
  }

  async execute(request: QualityAdapterRequest): Promise<QualityAdapterOutput> {
    const config = request.config.performance;
    if (!config.enabled) {
      return {
        results: [
          performanceResult({
            request,
            testKey: "performance.browser-timing.enabled",
            title: "Browser performance adapter enabled",
            status: "SKIPPED",
            startedAt: now(),
            durationMs: 0,
            targetRef: request.url,
            expected: "performance.enabled: true",
            actual: "performance disabled by config",
            evidenceRefs: []
          })
        ],
        findings: [],
        evidence: []
      };
    }

    const availability = this.availability();
    if (availability.status !== "SUPPORTED") {
      return {
        results: [
          performanceResult({
            request,
            testKey: "performance.browser-timing.available",
            title: "Browser performance adapter availability",
            status: "BLOCKED",
            startedAt: now(),
            durationMs: 0,
            targetRef: request.url,
            expected: "Playwright Chromium available",
            actual: availability.reason ?? "unavailable",
            error: availability.reason ?? "unavailable",
            evidenceRefs: []
          })
        ],
        findings: [],
        evidence: []
      };
    }

    const results: NormalizedResult[] = [
      performanceResult({
        request,
        testKey: "performance.browser-timing.adapter",
        title: "Browser performance adapter execution health",
        status: "PASS",
        startedAt: now(),
        durationMs: 0,
        targetRef: request.url,
        expected: "browser timing adapter loaded without running load tests",
        actual: { engine: "browser-timing", capabilities: this.capabilities },
        evidenceRefs: []
      })
    ];
    const targets = selectPerformanceTargets({
      config: request.config,
      baseUrl: request.url,
      discoveredPages: request.discoveredPages
    });

    if (targets.length === 0) {
      results.push(
        performanceResult({
          request,
          testKey: "performance.browser-timing.targets",
          title: "Browser performance scan targets",
          status: "SKIPPED",
          startedAt: now(),
          durationMs: 0,
          targetRef: request.url,
          expected: "at least one eligible performance target",
          actual: "no eligible target URL found",
          evidenceRefs: []
        })
      );
      return { results, findings: [], evidence: [] };
    }

    const browser = await chromium.launch({ headless: this.options.headless ?? true });
    const pageOutputs: Array<{ result: NormalizedResult; findings: Finding[]; measurement?: BrowserTimingMeasurement }> = [];
    try {
      const context = await browser.newContext({ userAgent: PERFORMANCE_USER_AGENT });
      try {
        for (const target of targets) {
          pageOutputs.push(await this.scanTarget({ request, context, target }));
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }

    const measurements = pageOutputs.map((output) => output.measurement).filter((measurement): measurement is BrowserTimingMeasurement => Boolean(measurement));
    const evidence = maybeWritePerformanceEvidence({ request, measurements, outputs: pageOutputs });
    const findings = dedupeFindings(
      pageOutputs
        .flatMap((output) => output.findings)
        .map((finding) => ({
          ...finding,
          evidenceRefs: evidence
        }))
    );
    const findingIds = new Set(findings.map((finding) => finding.id));
    results.push(
      ...pageOutputs.map((output) => ({
        ...output.result,
        findingRefs: output.result.findingRefs.filter((id) => findingIds.has(id)),
        evidenceRefs: shouldAttachEvidence(output.result, evidence) ? evidence : output.result.evidenceRefs
      }))
    );

    return { results, findings, evidence };
  }

  private async scanTarget(input: { request: QualityAdapterRequest; context: BrowserContext; target: SelectedTarget }): Promise<{
    result: NormalizedResult;
    findings: Finding[];
    measurement?: BrowserTimingMeasurement;
  }> {
    const startedAt = now();
    const page = await input.context.newPage();
    try {
      await page.goto(input.target.url, {
        waitUntil: input.request.config.performance.waitUntil,
        timeout: input.request.config.performance.timeout_seconds * 1000
      });
      if (input.request.config.performance.waitUntil !== "networkidle") {
        await page.waitForLoadState("networkidle", { timeout: Math.min(input.request.config.performance.timeout_seconds * 1000, 1000) }).catch(() => undefined);
      }
      const measurement = normalizeBrowserTiming(await readBrowserTiming(page), safeUrlForReport(page.url()));
      const gate = evaluatePerformanceGate(measurement, input.request.config.performance);
      const findings = gate.breaches.map((breach) => performanceFinding({ request: input.request, measurement, breach }));
      const result = performanceResult({
        request: input.request,
        testKey: performanceTestKey(input.target.url),
        title: `Browser performance scan ${input.target.label}`,
        status: gate.passed ? "PASS" : "FAIL",
        startedAt,
        durationMs: elapsedMs(startedAt, now()),
        targetRef: measurement.pageUrl,
        expected: input.request.config.performance.thresholds,
        actual: {
          page: measurement.pageUrl,
          measurement,
          breaches: gate.breaches
        },
        error: gate.passed ? undefined : gate.breaches.map((breach) => `${breach.metric}=${breach.actual} limit=${breach.threshold}`).join(", "),
        evidenceRefs: [],
        findingRefs: findings.map((finding) => finding.id)
      });
      return { result, findings, measurement };
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error), input.request.config.report.redact_headers);
      return {
        result: performanceResult({
          request: input.request,
          testKey: performanceTestKey(input.target.url),
          title: `Browser performance scan ${input.target.label}`,
          status: "ERROR",
          startedAt,
          durationMs: elapsedMs(startedAt, now()),
          targetRef: safeUrlForReport(input.target.url),
          expected: "page navigates and browser timing metrics are available",
          actual: { error: message },
          error: message,
          evidenceRefs: []
        }),
        findings: []
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

export class PassiveSecurityAdapter implements QualityAdapter {
  readonly id = SECURITY_ADAPTER_ID;
  readonly version = SECURITY_ADAPTER_VERSION;
  readonly category = "security" as const;
  readonly capabilities = ["passive-http", "security-headers", "cookie-flags", "public-pages", "bounded-evidence"];

  constructor(private readonly options: PassiveSecurityAdapterOptions = {}) {}

  availability(): QualityAdapterAvailability {
    if (this.options.unavailableReason) {
      return { status: "UNAVAILABLE", reason: this.options.unavailableReason };
    }
    return { status: "SUPPORTED" };
  }

  async execute(request: QualityAdapterRequest): Promise<QualityAdapterOutput> {
    const config = request.config.security;
    if (!config.enabled) {
      return {
        results: [
          securityResult({
            request,
            testKey: "security.passive-http.enabled",
            title: "Passive security adapter enabled",
            status: "SKIPPED",
            startedAt: now(),
            durationMs: 0,
            targetRef: request.url,
            expected: "security.enabled: true",
            actual: "security disabled by config",
            evidenceRefs: []
          })
        ],
        findings: [],
        evidence: []
      };
    }

    const availability = this.availability();
    if (availability.status !== "SUPPORTED") {
      return {
        results: [
          securityResult({
            request,
            testKey: "security.passive-http.available",
            title: "Passive security adapter availability",
            status: "BLOCKED",
            startedAt: now(),
            durationMs: 0,
            targetRef: request.url,
            expected: "passive security adapter available",
            actual: availability.reason ?? "unavailable",
            error: availability.reason ?? "unavailable",
            evidenceRefs: []
          })
        ],
        findings: [],
        evidence: []
      };
    }

    const results: NormalizedResult[] = [
      securityResult({
        request,
        testKey: "security.passive-http.adapter",
        title: "Passive security adapter execution health",
        status: "PASS",
        startedAt: now(),
        durationMs: 0,
        targetRef: request.url,
        expected: "passive HTTP checks load without active scanning",
        actual: { engine: "passive-http", capabilities: this.capabilities },
        evidenceRefs: []
      })
    ];
    const targets = selectSecurityTargets({
      config: request.config,
      baseUrl: request.url,
      discoveredPages: request.discoveredPages
    });

    if (targets.length === 0) {
      results.push(
        securityResult({
          request,
          testKey: "security.passive-http.targets",
          title: "Passive security scan targets",
          status: "SKIPPED",
          startedAt: now(),
          durationMs: 0,
          targetRef: request.url,
          expected: "at least one eligible passive security target",
          actual: "no eligible target URL found",
          evidenceRefs: []
        })
      );
      return { results, findings: [], evidence: [] };
    }

    const outputs: Array<{ result: NormalizedResult; findings: Finding[]; observation?: PassiveSecurityObservation }> = [];
    for (const target of targets) {
      outputs.push(await this.scanTarget({ request, target }));
    }

    const observations = outputs.map((output) => output.observation).filter((observation): observation is PassiveSecurityObservation => Boolean(observation));
    const evidence = maybeWriteSecurityEvidence({ request, observations, outputs });
    const findings = dedupeFindings(
      outputs
        .flatMap((output) => output.findings)
        .map((finding) => ({
          ...finding,
          evidenceRefs: evidence
        }))
    );
    const findingIds = new Set(findings.map((finding) => finding.id));
    results.push(
      ...outputs.map((output) => ({
        ...output.result,
        findingRefs: output.result.findingRefs.filter((id) => findingIds.has(id)),
        evidenceRefs: shouldAttachEvidence(output.result, evidence) ? evidence : output.result.evidenceRefs
      }))
    );

    return { results, findings, evidence };
  }

  private async scanTarget(input: { request: QualityAdapterRequest; target: SelectedTarget }): Promise<{
    result: NormalizedResult;
    findings: Finding[];
    observation?: PassiveSecurityObservation;
  }> {
    const startedAt = now();
    try {
      const response = await (this.options.fetchResponse ?? fetchPassiveSecurityResponse)(input.target.url, input.request.config.security.timeout_seconds * 1000);
      const observation = normalizePassiveSecurityObservation(response, input.request.config.security);
      const gate = evaluatePassiveSecurityGate(observation, input.request.config.security);
      const findings = observation.issues.map((issue) => securityFinding({ request: input.request, observation, issue }));
      const result = securityResult({
        request: input.request,
        testKey: securityTestKey(input.target.url),
        title: `Passive security scan ${input.target.label}`,
        status: gate.passed ? "PASS" : "FAIL",
        startedAt,
        durationMs: elapsedMs(startedAt, now()),
        targetRef: observation.pageUrl,
        expected: {
          engine: input.request.config.security.engine,
          failOn: input.request.config.security.failOn,
          checks: input.request.config.security.checks
        },
        actual: {
          page: observation.pageUrl,
          statusCode: observation.statusCode,
          issueCount: observation.issues.length,
          breachCount: gate.breaches.length,
          issues: observation.issues
        },
        error: gate.passed ? undefined : gate.breaches.map((breach) => breach.check).join(", "),
        evidenceRefs: [],
        findingRefs: findings.map((finding) => finding.id)
      });
      return { result, findings, observation };
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error), input.request.config.report.redact_headers);
      return {
        result: securityResult({
          request: input.request,
          testKey: securityTestKey(input.target.url),
          title: `Passive security scan ${input.target.label}`,
          status: "ERROR",
          startedAt,
          durationMs: elapsedMs(startedAt, now()),
          targetRef: safeUrlForReport(input.target.url),
          expected: "target responds to passive HTTP inspection",
          actual: { error: message },
          error: message,
          evidenceRefs: []
        }),
        findings: []
      };
    }
  }
}

export class HttpLoadSmokeAdapter implements QualityAdapter {
  readonly id = LOAD_ADAPTER_ID;
  readonly version = LOAD_ADAPTER_VERSION;
  readonly category = "load" as const;
  readonly capabilities = ["http-smoke", "explicit-opt-in", "bounded-concurrency", "public-targets", "bounded-evidence"];

  constructor(private readonly options: HttpLoadSmokeAdapterOptions = {}) {}

  availability(): QualityAdapterAvailability {
    if (this.options.unavailableReason) {
      return { status: "UNAVAILABLE", reason: this.options.unavailableReason };
    }
    return { status: "SUPPORTED" };
  }

  async execute(request: QualityAdapterRequest): Promise<QualityAdapterOutput> {
    const config = request.config.load;
    if (!config.enabled) {
      return {
        results: [
          loadResult({
            request,
            testKey: "load.http-smoke.enabled",
            title: "HTTP load smoke adapter enabled",
            status: "SKIPPED",
            startedAt: now(),
            durationMs: 0,
            targetRef: request.url,
            expected: "load.enabled: true",
            actual: "load disabled by config",
            evidenceRefs: []
          })
        ],
        findings: [],
        evidence: []
      };
    }

    if (!request.config.safety.load_test) {
      return {
        results: [
          loadResult({
            request,
            testKey: "load.http-smoke.safety",
            title: "HTTP load smoke safety opt-in",
            status: "BLOCKED",
            startedAt: now(),
            durationMs: 0,
            targetRef: request.url,
            expected: "safety.load_test: true",
            actual: "load test opt-in is false",
            error: "load tests require explicit safety.load_test opt-in",
            evidenceRefs: []
          })
        ],
        findings: [],
        evidence: []
      };
    }

    if (request.config.target.environment === "production") {
      return {
        results: [
          loadResult({
            request,
            testKey: "load.http-smoke.production",
            title: "HTTP load smoke production guard",
            status: "BLOCKED",
            startedAt: now(),
            durationMs: 0,
            targetRef: request.url,
            expected: "non-production target",
            actual: "production target",
            error: "load tests are blocked for production targets",
            evidenceRefs: []
          })
        ],
        findings: [],
        evidence: []
      };
    }

    const availability = this.availability();
    if (availability.status !== "SUPPORTED") {
      return {
        results: [
          loadResult({
            request,
            testKey: "load.http-smoke.available",
            title: "HTTP load smoke adapter availability",
            status: "BLOCKED",
            startedAt: now(),
            durationMs: 0,
            targetRef: request.url,
            expected: "HTTP load smoke adapter available",
            actual: availability.reason ?? "unavailable",
            error: availability.reason ?? "unavailable",
            evidenceRefs: []
          })
        ],
        findings: [],
        evidence: []
      };
    }

    const results: NormalizedResult[] = [
      loadResult({
        request,
        testKey: "load.http-smoke.adapter",
        title: "HTTP load smoke adapter execution health",
        status: "PASS",
        startedAt: now(),
        durationMs: 0,
        targetRef: request.url,
        expected: "bounded HTTP smoke load adapter loaded",
        actual: { engine: "http-smoke", capabilities: this.capabilities },
        evidenceRefs: []
      })
    ];
    const targets = selectLoadTargets({
      config: request.config,
      baseUrl: request.url,
      discoveredPages: request.discoveredPages
    });

    if (targets.length === 0) {
      results.push(
        loadResult({
          request,
          testKey: "load.http-smoke.targets",
          title: "HTTP load smoke targets",
          status: "SKIPPED",
          startedAt: now(),
          durationMs: 0,
          targetRef: request.url,
          expected: "at least one eligible load target",
          actual: "no eligible target URL found",
          evidenceRefs: []
        })
      );
      return { results, findings: [], evidence: [] };
    }

    const outputs: Array<{ result: NormalizedResult; findings: Finding[]; measurement?: LoadMeasurement }> = [];
    for (const target of targets) {
      outputs.push(await this.scanTarget({ request, target }));
    }

    const measurements = outputs.map((output) => output.measurement).filter((measurement): measurement is LoadMeasurement => Boolean(measurement));
    const evidence = maybeWriteLoadEvidence({ request, measurements, outputs });
    const findings = dedupeFindings(
      outputs
        .flatMap((output) => output.findings)
        .map((finding) => ({
          ...finding,
          evidenceRefs: evidence
        }))
    );
    const findingIds = new Set(findings.map((finding) => finding.id));
    results.push(
      ...outputs.map((output) => ({
        ...output.result,
        findingRefs: output.result.findingRefs.filter((id) => findingIds.has(id)),
        evidenceRefs: shouldAttachEvidence(output.result, evidence) ? evidence : output.result.evidenceRefs
      }))
    );

    return { results, findings, evidence };
  }

  private async scanTarget(input: { request: QualityAdapterRequest; target: SelectedTarget }): Promise<{
    result: NormalizedResult;
    findings: Finding[];
    measurement?: LoadMeasurement;
  }> {
    const startedAt = now();
    try {
      const measurement = await runLoadSmoke({
        url: input.target.url,
        config: input.request.config.load,
        maxConcurrency: input.request.config.safety.max_concurrency,
        fetchSample: this.options.fetchSample ?? fetchLoadSample
      });
      const gate = evaluateLoadGate(measurement, input.request.config.load);
      const findings = gate.breaches.map((breach) => loadFinding({ request: input.request, measurement, breach }));
      const result = loadResult({
        request: input.request,
        testKey: loadTestKey(input.target.url),
        title: `HTTP load smoke ${input.target.label}`,
        status: gate.passed ? "PASS" : "FAIL",
        startedAt,
        durationMs: elapsedMs(startedAt, now()),
        targetRef: measurement.pageUrl,
        expected: input.request.config.load.thresholds,
        actual: {
          page: measurement.pageUrl,
          measurement,
          breaches: gate.breaches
        },
        error: gate.passed ? undefined : gate.breaches.map((breach) => `${breach.metric}=${breach.actual} limit=${breach.threshold}`).join(", "),
        evidenceRefs: [],
        findingRefs: findings.map((finding) => finding.id)
      });
      return { result, findings, measurement };
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error), input.request.config.report.redact_headers);
      return {
        result: loadResult({
          request: input.request,
          testKey: loadTestKey(input.target.url),
          title: `HTTP load smoke ${input.target.label}`,
          status: "ERROR",
          startedAt,
          durationMs: elapsedMs(startedAt, now()),
          targetRef: safeUrlForReport(input.target.url),
          expected: "target responds during bounded load smoke",
          actual: { error: message },
          error: message,
          evidenceRefs: []
        }),
        findings: []
      };
    }
  }
}

export function accessibilitySeverity(impact: AccessibilityImpact): Finding["severity"] {
  switch (impact) {
    case "critical":
      return "Critical";
    case "serious":
      return "High";
    case "moderate":
      return "Medium";
    case "minor":
      return "Low";
    case "none":
      return "Info";
  }
}

export function evaluateAccessibilityGate(violations: NormalizedAccessibilityViolation[], config: AccessibilityConfig): AccessibilityGateResult {
  const counts: Record<AccessibilityImpact, number> = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
    none: 0
  };
  for (const violation of violations) {
    counts[violation.impact] += 1;
  }

  const breaches = config.failOn
    .map((impact) => ({ impact, count: counts[impact], limit: config.maxViolations[impact] ?? 0 }))
    .filter((breach) => breach.count > breach.limit);
  return {
    passed: breaches.length === 0,
    counts,
    breaches
  };
}

export function selectAccessibilityTargets(input: {
  config: QAgentConfig;
  baseUrl: string;
  discoveredPages: DiscoveredPage[];
  profileName: string;
  maxPages?: number;
}): SelectedTarget[] {
  const configured = input.config.accessibility.include;
  const rawUrls = configured?.length
    ? configured
    : input.profileName !== "public"
      ? [input.config.auth.profiles[input.profileName]?.success.urlContains ?? "/"]
      : input.discoveredPages.length > 0
        ? input.discoveredPages.map((page) => page.finalUrl ?? page.url)
        : [input.baseUrl];
  const exclude = [...input.config.discovery.exclude, ...input.config.accessibility.exclude];
  const byUrl = new Map<string, SelectedTarget>();

  for (const rawUrl of rawUrls) {
    const resolved = resolveAllowedUrl(rawUrl, input.baseUrl, input.config, exclude);
    if (!resolved) {
      continue;
    }
    byUrl.set(resolved, {
      url: resolved,
      label: pageLabel(resolved)
    });
  }

  return [...byUrl.values()]
    .sort((left, right) => left.url.localeCompare(right.url))
    .slice(0, input.maxPages ?? input.config.accessibility.maxPages);
}

export function selectPerformanceTargets(input: {
  config: QAgentConfig;
  baseUrl: string;
  discoveredPages: DiscoveredPage[];
  maxPages?: number;
}): SelectedTarget[] {
  const configured = input.config.performance.include;
  const rawUrls = configured?.length ? configured : input.discoveredPages.length > 0 ? input.discoveredPages.map((page) => page.finalUrl ?? page.url) : [input.baseUrl];
  const exclude = [...input.config.discovery.exclude, ...input.config.performance.exclude];
  const byUrl = new Map<string, SelectedTarget>();

  for (const rawUrl of rawUrls) {
    const resolved = resolveAllowedUrl(rawUrl, input.baseUrl, input.config, exclude);
    if (!resolved) {
      continue;
    }
    byUrl.set(resolved, {
      url: resolved,
      label: pageLabel(resolved)
    });
  }

  return [...byUrl.values()]
    .sort((left, right) => left.url.localeCompare(right.url))
    .slice(0, input.maxPages ?? input.config.performance.maxPages);
}

export function selectSecurityTargets(input: {
  config: QAgentConfig;
  baseUrl: string;
  discoveredPages: DiscoveredPage[];
  maxPages?: number;
}): SelectedTarget[] {
  const configured = input.config.security.include;
  const rawUrls = configured?.length ? configured : input.discoveredPages.length > 0 ? input.discoveredPages.map((page) => page.finalUrl ?? page.url) : [input.baseUrl];
  const exclude = [...input.config.discovery.exclude, ...input.config.security.exclude];
  const byUrl = new Map<string, SelectedTarget>();

  for (const rawUrl of rawUrls) {
    const resolved = resolveAllowedUrl(rawUrl, input.baseUrl, input.config, exclude);
    if (!resolved) {
      continue;
    }
    byUrl.set(resolved, {
      url: resolved,
      label: pageLabel(resolved)
    });
  }

  return [...byUrl.values()]
    .sort((left, right) => left.url.localeCompare(right.url))
    .slice(0, input.maxPages ?? input.config.security.maxPages);
}

export function selectLoadTargets(input: {
  config: QAgentConfig;
  baseUrl: string;
  discoveredPages: DiscoveredPage[];
  maxPages?: number;
}): SelectedTarget[] {
  const configured = input.config.load.include;
  const rawUrls = configured?.length ? configured : input.discoveredPages.length > 0 ? input.discoveredPages.map((page) => page.finalUrl ?? page.url) : [input.baseUrl];
  const exclude = [...input.config.discovery.exclude, ...input.config.load.exclude];
  const byUrl = new Map<string, SelectedTarget>();

  for (const rawUrl of rawUrls) {
    const resolved = resolveAllowedUrl(rawUrl, input.baseUrl, input.config, exclude);
    if (!resolved) {
      continue;
    }
    byUrl.set(resolved, {
      url: resolved,
      label: pageLabel(resolved)
    });
  }

  return [...byUrl.values()]
    .sort((left, right) => left.url.localeCompare(right.url))
    .slice(0, input.maxPages ?? input.config.load.maxPages);
}

export function normalizeAxeResults(input: {
  raw: Pick<AxeResults, "violations">;
  pageUrl: string;
  config: AccessibilityConfig;
  redactHeaders: string[];
  secretValues?: string[];
}): NormalizedAccessibilityViolation[] {
  const violations: NormalizedAccessibilityViolation[] = [];
  for (const violation of input.raw.violations) {
    const nodes = violation.nodes.slice(0, input.config.maxNodesPerRule);
    for (const node of nodes) {
      violations.push(normalizeAxeViolation({ violation, node, pageUrl: input.pageUrl, redactHeaders: input.redactHeaders, secretValues: input.secretValues ?? [] }));
    }
  }
  return violations.sort((left, right) => [left.ruleId, left.pageUrl, left.target].join("|").localeCompare([right.ruleId, right.pageUrl, right.target].join("|")));
}

export function normalizeAxeViolation(input: {
  violation: AxeResult;
  node: AxeNodeResult;
  pageUrl: string;
  redactHeaders: string[];
  secretValues?: string[];
}): NormalizedAccessibilityViolation {
  const impact = normalizeImpact(input.node.impact ?? input.violation.impact ?? null);
  const target = selectorSignature(input.node.target);
  const fingerprint = createHash("sha256").update([ADAPTER_ID, input.violation.id, safeUrlForReport(input.pageUrl), target].join("|")).digest("hex").slice(0, 24);
  return {
    fingerprint,
    ruleId: input.violation.id,
    impact,
    severity: accessibilitySeverity(impact),
    description: sanitizeText(input.violation.description, input.redactHeaders, input.secretValues ?? []),
    help: sanitizeText(input.violation.help, input.redactHeaders, input.secretValues ?? []),
    helpUrl: sanitizeText(input.violation.helpUrl, input.redactHeaders, input.secretValues ?? []),
    pageUrl: safeUrlForReport(input.pageUrl),
    target,
    html: sanitizeHtmlSnippet(input.node.html, input.redactHeaders, input.secretValues ?? []),
    failureSummary: sanitizeText(input.node.failureSummary ?? "", input.redactHeaders, input.secretValues ?? [])
  };
}

export function accessibilityFindingFingerprint(violation: NormalizedAccessibilityViolation): string {
  return violation.fingerprint;
}

export function normalizeBrowserTiming(raw: Record<string, unknown>, pageUrl: string): BrowserTimingMeasurement {
  return {
    pageUrl: safeUrlForReport(pageUrl),
    firstByteMs: nonNegativeRounded(raw.responseStart),
    domContentLoadedMs: nonNegativeRounded(raw.domContentLoadedEventEnd),
    loadEventMs: nonNegativeRounded(raw.loadEventEnd),
    transferSizeBytes: nonNegativeRounded(raw.transferSize),
    encodedBodySizeBytes: nonNegativeRounded(raw.encodedBodySize),
    decodedBodySizeBytes: nonNegativeRounded(raw.decodedBodySize),
    resourceCount: nonNegativeRounded(raw.resourceCount),
    resourceTransferSizeBytes: nonNegativeRounded(raw.resourceTransferSize)
  };
}

export function evaluatePerformanceGate(measurement: BrowserTimingMeasurement, config: PerformanceConfig): PerformanceGateResult {
  const metrics: Array<{ threshold: keyof PerformanceConfig["thresholds"]; value: number }> = [
    { threshold: "maxFirstByteMs", value: measurement.firstByteMs },
    { threshold: "maxDomContentLoadedMs", value: measurement.domContentLoadedMs },
    { threshold: "maxLoadEventMs", value: measurement.loadEventMs },
    { threshold: "maxTransferSizeBytes", value: measurement.transferSizeBytes + measurement.resourceTransferSizeBytes },
    { threshold: "maxResourceCount", value: measurement.resourceCount }
  ];
  const breaches = metrics
    .map(({ threshold, value }) => ({ metric: threshold, actual: value, threshold: config.thresholds[threshold] }))
    .filter((breach): breach is PerformanceThresholdBreach => breach.threshold !== undefined && breach.actual > breach.threshold);

  return {
    passed: breaches.length === 0,
    breaches
  };
}

export function performanceFindingFingerprint(measurement: BrowserTimingMeasurement, breach: PerformanceThresholdBreach): string {
  return createHash("sha256").update([PERFORMANCE_ADAPTER_ID, measurement.pageUrl, breach.metric].join("|")).digest("hex").slice(0, 24);
}

export function normalizePassiveSecurityObservation(response: PassiveSecurityHttpResponse, config: SecurityConfig): PassiveSecurityObservation {
  const pageUrl = safeUrlForReport(response.pageUrl);
  const headers = normalizeHeaderMap(response.headers);
  const cookies = response.setCookie.map(parseSetCookie).filter((cookie): cookie is PassiveSecurityCookie => Boolean(cookie));
  const observation: PassiveSecurityObservation = {
    pageUrl,
    statusCode: response.statusCode,
    headers,
    cookies,
    issues: []
  };
  observation.issues = passiveSecurityIssues(observation, config);
  return observation;
}

export function evaluatePassiveSecurityGate(observation: PassiveSecurityObservation, config: SecurityConfig): SecurityGateResult {
  const failOn = new Set(config.failOn);
  const breaches = observation.issues.filter((issue) => failOn.has(issue.check));
  return {
    passed: breaches.length === 0,
    breaches
  };
}

export function securityFindingFingerprint(observation: PassiveSecurityObservation, issue: PassiveSecurityIssue): string {
  const evidenceTarget = String(issue.evidence.cookieName ?? issue.evidence.header ?? issue.check);
  return createHash("sha256").update([SECURITY_ADAPTER_ID, observation.pageUrl, issue.check, evidenceTarget].join("|")).digest("hex").slice(0, 24);
}

export function summarizeLoadSamples(pageUrl: string, samples: LoadSample[]): LoadMeasurement {
  const durations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const totalRequests = samples.length;
  const failedRequests = samples.filter((sample) => !sample.ok).length;
  return {
    pageUrl: safeUrlForReport(pageUrl),
    totalRequests,
    failedRequests,
    errorRate: totalRequests > 0 ? Number((failedRequests / totalRequests).toFixed(4)) : 0,
    averageMs: roundedAverage(durations),
    p95Ms: percentile(durations, 0.95),
    samples
  };
}

export function evaluateLoadGate(measurement: LoadMeasurement, config: LoadConfig): LoadGateResult {
  const metrics: Array<{ threshold: keyof LoadConfig["thresholds"]; value: number }> = [
    { threshold: "maxErrorRate", value: measurement.errorRate },
    { threshold: "maxAverageMs", value: measurement.averageMs },
    { threshold: "maxP95Ms", value: measurement.p95Ms }
  ];
  const breaches = metrics
    .map(({ threshold, value }) => ({ metric: threshold, actual: value, threshold: config.thresholds[threshold] }))
    .filter((breach): breach is LoadThresholdBreach => breach.threshold !== undefined && breach.actual > breach.threshold);

  return {
    passed: breaches.length === 0,
    breaches
  };
}

export function loadFindingFingerprint(measurement: LoadMeasurement, breach: LoadThresholdBreach): string {
  return createHash("sha256").update([LOAD_ADAPTER_ID, measurement.pageUrl, breach.metric].join("|")).digest("hex").slice(0, 24);
}

function maybeWriteAccessibilityEvidence(input: {
  request: QualityAdapterRequest;
  violations: NormalizedAccessibilityViolation[];
  outputs: PageScanOutput[];
}): EvidenceRef[] {
  const evidenceOn = input.request.config.report.evidence_on;
  const shouldWrite = evidenceOn === "always" || (input.violations.length > 0 && evidenceOn !== "never");
  if (!shouldWrite) {
    return [];
  }

  const relativeDir = "evidence/accessibility";
  const fullDir = join(input.request.artifactDir, relativeDir);
  mkdirSync(fullDir, { recursive: true });

  const manifest = {
    format: "qagent.accessibility.manifest.v1",
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    engine: "axe-core",
    engineVersion: axe.version,
    pagesScanned: input.outputs.filter((output) => output.result.status !== "BLOCKED" && output.result.status !== "ERROR").length,
    totalViolations: input.violations.length,
    resultKeys: input.outputs.map((output) => output.result.testKey)
  };
  const violations = {
    format: "qagent.accessibility.violations.v1",
    violations: input.violations
  };

  const manifestRef = writeEvidenceJson(input.request, `${relativeDir}/manifest.json`, manifest);
  const violationsRef = writeEvidenceJson(input.request, `${relativeDir}/violations.json`, violations);
  return [manifestRef, violationsRef];
}

function maybeWritePerformanceEvidence(input: {
  request: QualityAdapterRequest;
  measurements: BrowserTimingMeasurement[];
  outputs: Array<{ result: NormalizedResult }>;
}): EvidenceRef[] {
  const evidenceOn = input.request.config.report.evidence_on;
  const hasFailure = input.outputs.some((output) => output.result.status === "FAIL" || output.result.status === "ERROR");
  const shouldWrite = evidenceOn === "always" || (input.measurements.length > 0 && hasFailure && evidenceOn !== "never");
  if (!shouldWrite) {
    return [];
  }

  const relativeDir = "evidence/performance";
  const payload = {
    format: "qagent.performance.browser-timing.v1",
    adapterId: PERFORMANCE_ADAPTER_ID,
    adapterVersion: PERFORMANCE_ADAPTER_VERSION,
    engine: "browser-timing",
    pagesScanned: input.measurements.length,
    thresholds: input.request.config.performance.thresholds,
    resultKeys: input.outputs.map((output) => output.result.testKey),
    measurements: input.measurements
  };

  return [writeEvidenceJson(input.request, `${relativeDir}/measurements.json`, payload)];
}

function maybeWriteSecurityEvidence(input: {
  request: QualityAdapterRequest;
  observations: PassiveSecurityObservation[];
  outputs: Array<{ result: NormalizedResult }>;
}): EvidenceRef[] {
  const evidenceOn = input.request.config.report.evidence_on;
  const hasFailure = input.outputs.some((output) => output.result.status === "FAIL" || output.result.status === "ERROR");
  const shouldWrite = evidenceOn === "always" || (input.observations.length > 0 && hasFailure && evidenceOn !== "never");
  if (!shouldWrite) {
    return [];
  }

  const relativeDir = "evidence/security";
  const payload = {
    format: "qagent.security.passive-http.v1",
    adapterId: SECURITY_ADAPTER_ID,
    adapterVersion: SECURITY_ADAPTER_VERSION,
    engine: "passive-http",
    pagesScanned: input.observations.length,
    failOn: input.request.config.security.failOn,
    checks: input.request.config.security.checks,
    resultKeys: input.outputs.map((output) => output.result.testKey),
    observations: input.observations
  };

  return [writeEvidenceJson(input.request, `${relativeDir}/passive-findings.json`, payload)];
}

function maybeWriteLoadEvidence(input: {
  request: QualityAdapterRequest;
  measurements: LoadMeasurement[];
  outputs: Array<{ result: NormalizedResult }>;
}): EvidenceRef[] {
  const evidenceOn = input.request.config.report.evidence_on;
  const hasFailure = input.outputs.some((output) => output.result.status === "FAIL" || output.result.status === "ERROR");
  const shouldWrite = evidenceOn === "always" || (input.measurements.length > 0 && hasFailure && evidenceOn !== "never");
  if (!shouldWrite) {
    return [];
  }

  const relativeDir = "evidence/load";
  const payload = {
    format: "qagent.load.http-smoke.v1",
    adapterId: LOAD_ADAPTER_ID,
    adapterVersion: LOAD_ADAPTER_VERSION,
    engine: "http-smoke",
    pagesScanned: input.measurements.length,
    config: {
      requestsPerTarget: input.request.config.load.requestsPerTarget,
      concurrency: input.request.config.load.concurrency,
      thresholds: input.request.config.load.thresholds
    },
    resultKeys: input.outputs.map((output) => output.result.testKey),
    measurements: input.measurements
  };

  return [writeEvidenceJson(input.request, `${relativeDir}/summary.json`, payload)];
}

function writeEvidenceJson(request: QualityAdapterRequest, relativePath: string, payload: unknown): EvidenceRef {
  const fullPath = join(request.artifactDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  const content = `${JSON.stringify(redactObject(payload, request.config.report.redact_headers), null, 2)}\n`;
  writeFileSync(fullPath, content, "utf8");
  const buffer = readFileSync(fullPath);
  const stat = statSync(fullPath);
  return {
    id: stableId(request.runId, "evidence", relativePath),
    type: "json",
    relativePath,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    size: stat.size
  };
}

function accessibilityFinding(input: { request: QualityAdapterRequest; violation: NormalizedAccessibilityViolation }): Finding {
  const title = `Accessibility violation: ${input.violation.ruleId}`;
  const description = `${input.violation.help} on ${input.violation.pageUrl} (${input.violation.target}).`;
  return {
    id: stableId(input.request.runId, "finding", input.violation.fingerprint),
    fingerprint: accessibilityFindingFingerprint(input.violation),
    category: "accessibility",
    severity: input.violation.severity,
    title,
    description: redactText(description, input.request.config.report.redact_headers),
    url: input.violation.pageUrl,
    endpoint: input.violation.pageUrl,
    remediationHint: input.violation.helpUrl,
    details: {
      ruleId: input.violation.ruleId,
      impact: input.violation.impact,
      selector: input.violation.target,
      html: input.violation.html,
      failureSummary: input.violation.failureSummary,
      help: input.violation.help,
      helpUrl: input.violation.helpUrl
    },
    evidenceRefs: [],
    redactionApplied: true
  };
}

function performanceFinding(input: {
  request: QualityAdapterRequest;
  measurement: BrowserTimingMeasurement;
  breach: PerformanceThresholdBreach;
}): Finding {
  const fingerprint = performanceFindingFingerprint(input.measurement, input.breach);
  const title = `Performance threshold exceeded: ${input.breach.metric}`;
  return {
    id: stableId(input.request.runId, "finding", fingerprint),
    fingerprint,
    category: "performance",
    severity: performanceSeverity(input.breach.metric),
    title,
    description: `${input.breach.metric} was ${input.breach.actual}, above threshold ${input.breach.threshold} on ${input.measurement.pageUrl}.`,
    url: input.measurement.pageUrl,
    endpoint: input.measurement.pageUrl,
    remediationHint: performanceRemediation(input.breach.metric),
    details: {
      metric: input.breach.metric,
      actual: input.breach.actual,
      threshold: input.breach.threshold,
      measurement: input.measurement
    },
    evidenceRefs: [],
    redactionApplied: true
  };
}

function securityFinding(input: {
  request: QualityAdapterRequest;
  observation: PassiveSecurityObservation;
  issue: PassiveSecurityIssue;
}): Finding {
  const fingerprint = securityFindingFingerprint(input.observation, input.issue);
  return {
    id: stableId(input.request.runId, "finding", fingerprint),
    fingerprint,
    category: "security",
    severity: input.issue.severity,
    title: input.issue.title,
    description: redactText(`${input.issue.description} on ${input.observation.pageUrl}.`, input.request.config.report.redact_headers),
    url: input.observation.pageUrl,
    endpoint: input.observation.pageUrl,
    remediationHint: input.issue.remediationHint,
    details: {
      check: input.issue.check,
      evidence: input.issue.evidence,
      statusCode: input.observation.statusCode
    },
    evidenceRefs: [],
    redactionApplied: true
  };
}

function loadFinding(input: {
  request: QualityAdapterRequest;
  measurement: LoadMeasurement;
  breach: LoadThresholdBreach;
}): Finding {
  const fingerprint = loadFindingFingerprint(input.measurement, input.breach);
  const title = `Load threshold exceeded: ${input.breach.metric}`;
  return {
    id: stableId(input.request.runId, "finding", fingerprint),
    fingerprint,
    category: "load",
    severity: loadSeverity(input.breach.metric),
    title,
    description: `${input.breach.metric} was ${input.breach.actual}, above threshold ${input.breach.threshold} on ${input.measurement.pageUrl}.`,
    url: input.measurement.pageUrl,
    endpoint: input.measurement.pageUrl,
    remediationHint: loadRemediation(input.breach.metric),
    details: {
      metric: input.breach.metric,
      actual: input.breach.actual,
      threshold: input.breach.threshold,
      measurement: {
        pageUrl: input.measurement.pageUrl,
        totalRequests: input.measurement.totalRequests,
        failedRequests: input.measurement.failedRequests,
        errorRate: input.measurement.errorRate,
        averageMs: input.measurement.averageMs,
        p95Ms: input.measurement.p95Ms
      }
    },
    evidenceRefs: [],
    redactionApplied: true
  };
}

function adapterResult(input: {
  request: QualityAdapterRequest;
  testKey: string;
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
  findingRefs?: string[];
}): NormalizedResult {
  return {
    id: randomUUID(),
    runId: input.request.runId,
    testKey: input.testKey,
    layer: "accessibility",
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
    findingRefs: input.findingRefs ?? [],
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION
  };
}

function performanceResult(input: {
  request: QualityAdapterRequest;
  testKey: string;
  title: string;
  status: ResultStatus;
  startedAt: string;
  durationMs: number;
  targetRef: string;
  expected: unknown;
  actual: unknown;
  error?: string;
  evidenceRefs: EvidenceRef[];
  findingRefs?: string[];
}): NormalizedResult {
  return {
    id: randomUUID(),
    runId: input.request.runId,
    testKey: input.testKey,
    layer: "performance",
    title: input.title,
    status: input.status,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    targetRef: input.targetRef,
    error: input.error ? redactText(input.error, input.request.config.report.redact_headers) : undefined,
    expected: input.expected,
    actual: input.actual,
    evidenceRefs: input.evidenceRefs,
    findingRefs: input.findingRefs ?? [],
    adapterId: PERFORMANCE_ADAPTER_ID,
    adapterVersion: PERFORMANCE_ADAPTER_VERSION
  };
}

function securityResult(input: {
  request: QualityAdapterRequest;
  testKey: string;
  title: string;
  status: ResultStatus;
  startedAt: string;
  durationMs: number;
  targetRef: string;
  expected: unknown;
  actual: unknown;
  error?: string;
  evidenceRefs: EvidenceRef[];
  findingRefs?: string[];
}): NormalizedResult {
  return {
    id: randomUUID(),
    runId: input.request.runId,
    testKey: input.testKey,
    layer: "security",
    title: input.title,
    status: input.status,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    targetRef: input.targetRef,
    error: input.error ? redactText(input.error, input.request.config.report.redact_headers) : undefined,
    expected: input.expected,
    actual: input.actual,
    evidenceRefs: input.evidenceRefs,
    findingRefs: input.findingRefs ?? [],
    adapterId: SECURITY_ADAPTER_ID,
    adapterVersion: SECURITY_ADAPTER_VERSION
  };
}

function loadResult(input: {
  request: QualityAdapterRequest;
  testKey: string;
  title: string;
  status: ResultStatus;
  startedAt: string;
  durationMs: number;
  targetRef: string;
  expected: unknown;
  actual: unknown;
  error?: string;
  evidenceRefs: EvidenceRef[];
  findingRefs?: string[];
}): NormalizedResult {
  return {
    id: randomUUID(),
    runId: input.request.runId,
    testKey: input.testKey,
    layer: "load",
    title: input.title,
    status: input.status,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    targetRef: input.targetRef,
    error: input.error ? redactText(input.error, input.request.config.report.redact_headers) : undefined,
    expected: input.expected,
    actual: input.actual,
    evidenceRefs: input.evidenceRefs,
    findingRefs: input.findingRefs ?? [],
    adapterId: LOAD_ADAPTER_ID,
    adapterVersion: LOAD_ADAPTER_VERSION
  };
}

async function readBrowserTiming(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const browserPerformance = (globalThis as unknown as {
      performance: {
        getEntriesByType(type: string): Array<Record<string, unknown>>;
      };
    }).performance;
    const navigation = browserPerformance.getEntriesByType("navigation")[0] ?? {};
    const resources = browserPerformance.getEntriesByType("resource");
    const resourceTransferSize = resources.reduce((sum, resource) => sum + Number(resource.transferSize ?? 0), 0);
    return {
      responseStart: navigation.responseStart,
      domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
      loadEventEnd: navigation.loadEventEnd,
      transferSize: navigation.transferSize,
      encodedBodySize: navigation.encodedBodySize,
      decodedBodySize: navigation.decodedBodySize,
      resourceCount: resources.length,
      resourceTransferSize
    };
  });
}

async function fetchPassiveSecurityResponse(url: string, timeoutMs: number): Promise<PassiveSecurityHttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": SECURITY_USER_AGENT
      }
    });
    await response.arrayBuffer().catch(() => undefined);

    const headers: Record<string, string> = {};
    for (const [name, value] of response.headers.entries()) {
      headers[name] = value;
    }
    const cookieReader = response.headers as unknown as { getSetCookie?: () => string[] };
    const fallbackCookie = response.headers.get("set-cookie");

    return {
      pageUrl: url,
      statusCode: response.status,
      headers,
      setCookie: cookieReader.getSetCookie?.() ?? (fallbackCookie ? [fallbackCookie] : [])
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runLoadSmoke(input: {
  url: string;
  config: LoadConfig;
  maxConcurrency: number;
  fetchSample: (url: string, timeoutMs: number) => Promise<LoadSample>;
}): Promise<LoadMeasurement> {
  const total = Math.max(1, input.config.requestsPerTarget);
  const concurrency = Math.max(1, Math.min(total, input.config.concurrency, input.maxConcurrency));
  const samples: LoadSample[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < total) {
      next += 1;
      samples.push(await input.fetchSample(input.url, input.config.timeout_seconds * 1000));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return summarizeLoadSamples(input.url, samples);
}

async function fetchLoadSample(url: string, timeoutMs: number): Promise<LoadSample> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": LOAD_USER_AGENT
      }
    });
    await response.arrayBuffer().catch(() => undefined);
    return {
      statusCode: response.status,
      durationMs: Math.max(0, Date.now() - started),
      ok: response.status >= 200 && response.status < 400
    };
  } catch (error) {
    return {
      durationMs: Math.max(0, Date.now() - started),
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function passiveSecurityIssues(observation: PassiveSecurityObservation, config: SecurityConfig): PassiveSecurityIssue[] {
  const issues: PassiveSecurityIssue[] = [];
  const headers = observation.headers;
  const csp = headers["content-security-policy"] ?? "";

  if (securityCheckEnabled(config, "content-security-policy") && !csp) {
    issues.push(securityIssue("content-security-policy", { header: "content-security-policy" }));
  }
  if (securityCheckEnabled(config, "frame-protection") && !headers["x-frame-options"] && !/(^|;)\s*frame-ancestors\b/i.test(csp)) {
    issues.push(securityIssue("frame-protection", { header: "x-frame-options|content-security-policy.frame-ancestors" }));
  }
  if (securityCheckEnabled(config, "x-content-type-options") && !/^nosniff$/i.test(headers["x-content-type-options"] ?? "")) {
    issues.push(securityIssue("x-content-type-options", { header: "x-content-type-options", actual: headers["x-content-type-options"] ?? "" }));
  }
  if (securityCheckEnabled(config, "referrer-policy") && !headers["referrer-policy"]) {
    issues.push(securityIssue("referrer-policy", { header: "referrer-policy" }));
  }
  if (securityCheckEnabled(config, "strict-transport-security") && new URL(observation.pageUrl).protocol === "https:" && !headers["strict-transport-security"]) {
    issues.push(securityIssue("strict-transport-security", { header: "strict-transport-security" }));
  }

  for (const cookie of observation.cookies) {
    if (securityCheckEnabled(config, "cookie-http-only") && !cookie.httpOnly) {
      issues.push(securityIssue("cookie-http-only", { cookieName: cookie.name }));
    }
    if (securityCheckEnabled(config, "cookie-secure") && new URL(observation.pageUrl).protocol === "https:" && !cookie.secure) {
      issues.push(securityIssue("cookie-secure", { cookieName: cookie.name }));
    }
    if (securityCheckEnabled(config, "cookie-same-site") && !cookie.sameSite) {
      issues.push(securityIssue("cookie-same-site", { cookieName: cookie.name }));
    }
  }

  return issues.sort((left, right) => [left.check, String(left.evidence.cookieName ?? left.evidence.header ?? "")].join("|").localeCompare([right.check, String(right.evidence.cookieName ?? right.evidence.header ?? "")].join("|")));
}

function securityCheckEnabled(config: SecurityConfig, check: SecurityCheckKey): boolean {
  return config.checks[check] !== false;
}

function normalizeHeaderMap(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.trim().toLowerCase();
    if (!key || key === "set-cookie") {
      continue;
    }
    normalized[key] = String(value);
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function parseSetCookie(header: string): PassiveSecurityCookie | undefined {
  const [nameValue = "", ...attributes] = header.split(";");
  const name = nameValue.split("=")[0]?.trim();
  if (!name) {
    return undefined;
  }
  const normalizedAttributes = attributes.map((attribute) => attribute.trim().toLowerCase());
  const sameSite = attributes.find((attribute) => /^\s*samesite=/i.test(attribute))?.split("=")[1]?.trim();
  return {
    name,
    httpOnly: normalizedAttributes.includes("httponly"),
    secure: normalizedAttributes.includes("secure"),
    sameSite
  };
}

function securityIssue(check: SecurityCheckKey, evidence: Record<string, unknown>): PassiveSecurityIssue {
  return {
    check,
    severity: securitySeverity(check),
    title: securityTitle(check),
    description: securityDescription(check),
    remediationHint: securityRemediation(check),
    evidence
  };
}

function performanceSeverity(metric: keyof PerformanceConfig["thresholds"]): Finding["severity"] {
  switch (metric) {
    case "maxFirstByteMs":
    case "maxLoadEventMs":
      return "High";
    case "maxDomContentLoadedMs":
      return "Medium";
    case "maxTransferSizeBytes":
    case "maxResourceCount":
      return "Low";
  }
}

function securitySeverity(check: SecurityCheckKey): Finding["severity"] {
  switch (check) {
    case "strict-transport-security":
    case "cookie-secure":
    case "cookie-http-only":
      return "High";
    case "content-security-policy":
    case "frame-protection":
    case "cookie-same-site":
      return "Medium";
    case "x-content-type-options":
    case "referrer-policy":
      return "Low";
  }
}

function securityTitle(check: SecurityCheckKey): string {
  switch (check) {
    case "content-security-policy":
      return "Missing Content-Security-Policy";
    case "frame-protection":
      return "Missing frame protection";
    case "x-content-type-options":
      return "Missing X-Content-Type-Options nosniff";
    case "referrer-policy":
      return "Missing Referrer-Policy";
    case "strict-transport-security":
      return "Missing Strict-Transport-Security";
    case "cookie-http-only":
      return "Cookie missing HttpOnly";
    case "cookie-secure":
      return "Cookie missing Secure";
    case "cookie-same-site":
      return "Cookie missing SameSite";
  }
}

function securityDescription(check: SecurityCheckKey): string {
  switch (check) {
    case "content-security-policy":
      return "The response does not define a Content-Security-Policy header";
    case "frame-protection":
      return "The response does not define X-Frame-Options or CSP frame-ancestors";
    case "x-content-type-options":
      return "The response does not set X-Content-Type-Options to nosniff";
    case "referrer-policy":
      return "The response does not define a Referrer-Policy header";
    case "strict-transport-security":
      return "The HTTPS response does not define Strict-Transport-Security";
    case "cookie-http-only":
      return "A response cookie can be read by client-side scripts";
    case "cookie-secure":
      return "A response cookie can be sent over insecure transport";
    case "cookie-same-site":
      return "A response cookie does not define a SameSite policy";
  }
}

function securityRemediation(check: SecurityCheckKey): string {
  switch (check) {
    case "content-security-policy":
      return "Add a restrictive Content-Security-Policy appropriate for the application.";
    case "frame-protection":
      return "Set CSP frame-ancestors or X-Frame-Options to prevent unwanted framing.";
    case "x-content-type-options":
      return "Set X-Content-Type-Options: nosniff for HTML and asset responses.";
    case "referrer-policy":
      return "Set Referrer-Policy to limit sensitive URL leakage across origins.";
    case "strict-transport-security":
      return "Set Strict-Transport-Security on HTTPS responses after confirming HTTPS rollout.";
    case "cookie-http-only":
      return "Set HttpOnly on session and sensitive cookies.";
    case "cookie-secure":
      return "Set Secure on cookies used over HTTPS.";
    case "cookie-same-site":
      return "Set SameSite=Lax, Strict, or an explicitly required SameSite=None policy.";
  }
}

function loadSeverity(metric: keyof LoadConfig["thresholds"]): Finding["severity"] {
  switch (metric) {
    case "maxErrorRate":
      return "High";
    case "maxP95Ms":
      return "Medium";
    case "maxAverageMs":
      return "Low";
  }
}

function loadRemediation(metric: keyof LoadConfig["thresholds"]): string {
  switch (metric) {
    case "maxErrorRate":
      return "Investigate failing responses, upstream dependencies, and server error logs under modest concurrent traffic.";
    case "maxAverageMs":
      return "Review average response latency, caching, database queries, and response payload size.";
    case "maxP95Ms":
      return "Review tail latency, slow endpoints, blocking work, and resource contention.";
  }
}

function performanceRemediation(metric: keyof PerformanceConfig["thresholds"]): string {
  switch (metric) {
    case "maxFirstByteMs":
      return "Review server response time, cache behavior, and backend dependencies.";
    case "maxDomContentLoadedMs":
      return "Reduce render-blocking scripts/styles and defer non-critical work.";
    case "maxLoadEventMs":
      return "Optimize page assets, long-running scripts, and load-event dependencies.";
    case "maxTransferSizeBytes":
      return "Compress and trim HTML, scripts, images, fonts, and other transferred assets.";
    case "maxResourceCount":
      return "Reduce request fan-out by bundling, caching, or removing unnecessary resources.";
  }
}

function roundedAverage(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], percent: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percent) - 1));
  return Math.round(values[index]);
}

function blockedScan(input: {
  request: QualityAdapterRequest;
  target: SelectedTarget;
  scope: string;
  startedAt: string;
  reason: string;
  actual: unknown;
  secretValues: string[];
}): PageScanOutput {
  const reason = sanitizeText(input.reason, input.request.config.report.redact_headers, input.secretValues);
  return {
    result: adapterResult({
      request: input.request,
      testKey: accessibilityTestKey(input.scope, input.target.url),
      title: `Axe accessibility scan ${input.scope} ${input.target.label}`,
      roleProfile: input.scope === "public" ? undefined : input.scope,
      status: "BLOCKED",
      startedAt: input.startedAt,
      durationMs: elapsedMs(input.startedAt, now()),
      targetRef: safeUrlForReport(input.target.url),
      expected: "authenticated session available",
      actual: input.actual,
      error: reason,
      evidenceRefs: []
    }),
    findings: [],
    violations: []
  };
}

function selectedProfiles(request: QualityAdapterRequest): string[] {
  const requested = request.config.accessibility.profiles;
  const names = requested.length > 0 ? requested : [];
  const selected = request.profile ? names.filter((name) => name === request.profile) : names;
  return [...new Set(selected)].sort();
}

function secretValuesForProfile(config: QAgentConfig, profileName: string): string[] {
  try {
    const profile = resolveAuthProfile(config, profileName);
    return [profile.credentials.username, profile.credentials.password];
  } catch {
    return [];
  }
}

function resolveAllowedUrl(rawUrl: string, baseUrl: string, config: QAgentConfig, exclude: string[]): string | undefined {
  let candidate: URL;
  let base: URL;
  try {
    candidate = new URL(rawUrl, baseUrl);
    base = new URL(baseUrl);
  } catch {
    return undefined;
  }

  if (!["http:", "https:"].includes(candidate.protocol)) {
    return undefined;
  }
  const normalizedCandidateHost = normalizeTargetHost(candidate.hostname);
  if (config.discovery.same_origin_only && !isSameOrigin(candidate, base)) {
    return undefined;
  }
  if ((config.target.allowed_hosts ?? []).length > 0 && !isAllowedTargetHost(candidate.hostname, config.target.allowed_hosts ?? [])) {
    return undefined;
  }
  if (matchesAny(candidate.pathname, exclude)) {
    return undefined;
  }
  candidate.hostname = normalizedCandidateHost;
  candidate.hash = "";
  candidate.search = "";
  return candidate.toString();
}

function isSameOrigin(candidate: URL, base: URL): boolean {
  return candidate.protocol === base.protocol && normalizeTargetHost(candidate.hostname) === normalizeTargetHost(base.hostname) && candidate.port === base.port;
}

function isAllowedTargetHost(hostname: string, allowedHosts: string[]): boolean {
  const normalizedHostname = normalizeTargetHost(hostname);
  return allowedHosts.map(normalizeTargetHost).includes(normalizedHostname);
}

function normalizeTargetHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

function matchesAny(pathname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(pathname);
  });
}

function pageLabel(url: string): string {
  const pathname = new URL(url).pathname;
  if (pathname === "/" || pathname === "") {
    return "home";
  }
  return safeKey(pathname.replace(/^\/+/, "").replace(/\/+$/g, "").replace(/\//g, "."));
}

function accessibilityTestKey(scope: string, url: string): string {
  return `accessibility.axe.${safeKey(scope)}.${pageLabel(url)}`;
}

function performanceTestKey(url: string): string {
  return `performance.browser-timing.public.${pageLabel(url)}`;
}

function securityTestKey(url: string): string {
  return `security.passive-http.public.${pageLabel(url)}`;
}

function loadTestKey(url: string): string {
  return `load.http-smoke.public.${pageLabel(url)}`;
}

function normalizeImpact(impact: axe.ImpactValue): AccessibilityImpact {
  return impact ?? "none";
}

function selectorSignature(target: AxeNodeResult["target"]): string {
  return target.map((item) => (Array.isArray(item) ? item.join(" ") : item)).join(" > ");
}

function sanitizeHtmlSnippet(input: string, redactHeaders: string[], secretValues: string[]): string {
  let output = sanitizeText(input, redactHeaders, secretValues);
  output = output.replace(/\s(value|data-[a-z0-9_-]*(?:token|secret|password|cookie|auth)[a-z0-9_-]*)=(["']).*?\2/gi, ' $1="<redacted>"');
  output = output.replace(/\s(value|data-[a-z0-9_-]*(?:token|secret|password|cookie|auth)[a-z0-9_-]*)=[^\s>]+/gi, ' $1="<redacted>"');
  return truncate(output, DEFAULT_MAX_HTML_SNIPPET);
}

function sanitizeText(input: string, redactHeaders: string[], secretValues: string[] = []): string {
  let output = redactText(input, redactHeaders);
  for (const secret of secretValues.filter((value) => value.length >= 3)) {
    output = output.split(secret).join("<redacted>");
  }
  return output;
}

function shouldAttachEvidence(result: NormalizedResult, evidence: EvidenceRef[]): boolean {
  return evidence.length > 0 && (result.status === "FAIL" || result.status === "PASS");
}

function dedupeFindings(findings: Finding[]): Finding[] {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}

function safeKey(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 120) || "target";
}

function stableId(runId: string, type: string, key: string): string {
  return `${runId}:${type}:${createHash("sha256").update(`${type}:${key}`).digest("hex").slice(0, 16)}`;
}

function truncate(input: string, limit: number): string {
  return input.length > limit ? `${input.slice(0, limit)}<truncated>` : input;
}

function nonNegativeRounded(input: unknown): number {
  const value = Number(input ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function now(): string {
  return new Date().toISOString();
}

function elapsedMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
