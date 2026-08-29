import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright";
import type { BrowserTestDefinition, BrowserTestFilter, BrowserTestOutcome } from "#browser-tests";
import { ConfigValidationError, resolveAuthProfile } from "#config";
import type { BrowserTestAdapter, BrowserTestOutput, BrowserTestRequest } from "#core";
import type { AuthProfileReport, BrowserTestMetadata, EvidenceRef, NormalizedResult } from "#contracts";
import { authProfileReport, firstAuthProfileName, PlaywrightAuthActionsImpl, sessionStatePath } from "./auth.js";
import type { PlaywrightBrowserTestContext } from "./browser-test-context.js";
import { createDefaultBrowserTestRegistry } from "./registered-tests.js";
import { adapterId, adapterVersion } from "./result-mapper.js";
import { elapsedMs, now } from "./ids.js";
import { captureBrowserTestEvidence, observeBrowserTestPage, sanitizeError } from "./test-evidence.js";
import { safeUrlForReport } from "./url-utils.js";

export interface BrowserTestRunnerOptions {
  headless?: boolean;
}

export class PlaywrightBrowserTestAdapter implements BrowserTestAdapter {
  readonly id = adapterId();
  readonly version = adapterVersion();

  constructor(private readonly options: BrowserTestRunnerOptions = {}) {}

  listTests(): BrowserTestMetadata[] {
    return createDefaultBrowserTestRegistry("admin").metadata();
  }

  async runTests(request: BrowserTestRequest): Promise<BrowserTestOutput> {
    mkdirSync(request.artifactDir, { recursive: true });

    const defaultProfile = request.profile ?? firstAuthProfileName(request.config);
    const registry = createDefaultBrowserTestRegistry(defaultProfile);
    validateRequestedKeys(registry.all(), request.testKeys);

    const filter: BrowserTestFilter = {
      keys: request.testKeys,
      tags: request.tags
    };
    const tests = registry.resolveExecutionOrder(filter);
    const registeredTests = tests.map(toMetadata);
    const profileNames = profileNamesForRun(request, tests, defaultProfile);
    const resolvedProfiles = profileNames.map((profileName) => ({
      name: profileName,
      profile: resolveAuthProfile(request.config, profileName)
    }));
    const secretValues = resolvedProfiles.flatMap(({ profile }) => [profile.credentials.username, profile.credentials.password]);
    const authProfiles = profileNames.map((profileName) => authProfileReport(request.config, request.url, profileName));

    const browser = await chromium.launch({ headless: this.options.headless ?? true });
    try {
      return await this.executeTests({
        browser,
        request,
        tests,
        registeredTests,
        authProfiles,
        secretValues,
        defaultProfile
      });
    } finally {
      await browser.close();
    }
  }

  private async executeTests(input: {
    browser: Browser;
    request: BrowserTestRequest;
    tests: BrowserTestDefinition<PlaywrightBrowserTestContext>[];
    registeredTests: BrowserTestMetadata[];
    authProfiles: AuthProfileReport[];
    secretValues: string[];
    defaultProfile: string;
  }): Promise<BrowserTestOutput> {
    const results: NormalizedResult[] = [];
    const evidence: EvidenceRef[] = [];
    const byKey = new Map<string, NormalizedResult>();

    for (const test of input.tests) {
      const blockedBy = blockedDependency(test, byKey);
      if (blockedBy) {
        const result = browserTestResult({
          request: input.request,
          test,
          startedAt: now(),
          durationMs: 0,
          targetRef: input.request.url,
          status: "BLOCKED",
          expected: {
            dependencies: test.dependencies.map((dependency) => ({ key: dependency, status: "PASS" }))
          },
          actual: {
            blockedBy: blockedBy.testKey,
            status: blockedBy.status,
            reason: blockedBy.error ?? "Dependency did not pass."
          },
          evidenceRefs: []
        });
        results.push(result);
        byKey.set(test.key, result);
        continue;
      }

      const context = await this.newContext(input.browser, input.request, test);
      const page = await context.newPage();
      const telemetry = observeBrowserTestPage(page, input.request.config.report.redact_headers, input.secretValues);
      const auth = new PlaywrightAuthActionsImpl({
        config: input.request.config,
        baseUrl: input.request.url,
        sessionRoot: input.request.sessionRoot,
        context,
        page
      });
      const startedAt = now();

      try {
        const outcome = await withTimeout(test.run({ baseUrl: input.request.url, runId: input.request.runId, profile: test.profile, config: input.request.config, context, page, auth, defaultProfile: input.defaultProfile }), test.timeoutMs);
        const durationMs = elapsedMs(startedAt, now());
        const resultEvidence = await this.maybeCaptureEvidence({
          request: input.request,
          evidenceKey: evidenceKeyForTest(test),
          page,
          telemetry,
          status: outcome.status,
          secretValues: input.secretValues
        });
        const evidenceRefs = [...(outcome.evidenceRefs ?? []), ...resultEvidence];
        evidence.push(...resultEvidence);
        const result = browserTestResult({
          request: input.request,
          test,
          startedAt,
          durationMs,
          targetRef: safeUrlForReport(page.url()),
          status: outcome.status,
          expected: outcome.expected,
          actual: outcome.actual,
          error: outcome.reason,
          evidenceRefs
        });
        results.push(result);
        byKey.set(test.key, result);
      } catch (error) {
        const durationMs = elapsedMs(startedAt, now());
        const sanitizedError = sanitizeError(error, input.request.config.report.redact_headers, input.secretValues);
        const resultEvidence = await this.maybeCaptureEvidence({
          request: input.request,
          evidenceKey: evidenceKeyForTest(test),
          page,
          telemetry,
          status: "ERROR",
          secretValues: input.secretValues
        });
        evidence.push(...resultEvidence);
        const result = browserTestResult({
          request: input.request,
          test,
          startedAt,
          durationMs,
          targetRef: safeUrlForReport(page.url() || input.request.url),
          status: "ERROR",
          expected: "browser test completed without throwing",
          actual: {
            error: sanitizedError
          },
          error: sanitizedError,
          evidenceRefs: resultEvidence
        });
        results.push(result);
        byKey.set(test.key, result);
      } finally {
        await context.close();
      }
    }

    return {
      results,
      findings: [],
      evidence: dedupeEvidence(evidence),
      authProfiles: input.authProfiles,
      registeredTests: input.registeredTests
    };
  }

  private async newContext(browser: Browser, request: BrowserTestRequest, test: BrowserTestDefinition<PlaywrightBrowserTestContext>): Promise<BrowserContext> {
    const options: BrowserContextOptions = {
      userAgent: "QAgent/0.1.0 Automated QA Runner"
    };
    if (test.profile && test.dependencies.includes("auth.valid-login")) {
      const statePath = sessionStatePath(request.sessionRoot, request.url, test.profile);
      if (existsSync(statePath)) {
        options.storageState = statePath;
      }
    }
    return browser.newContext(options);
  }

  private async maybeCaptureEvidence(input: {
    request: BrowserTestRequest;
    evidenceKey: string;
    page: import("playwright").Page;
    telemetry: ReturnType<typeof observeBrowserTestPage>;
    status: BrowserTestOutcome["status"] | "ERROR";
    secretValues: string[];
  }): Promise<EvidenceRef[]> {
    const evidenceOn = input.request.config.report.evidence_on;
    const shouldCapture = evidenceOn === "always" || ((input.status === "FAIL" || input.status === "ERROR") && evidenceOn !== "never");
    if (!shouldCapture) {
      return [];
    }
    return captureBrowserTestEvidence({
      page: input.page,
      artifactDir: input.request.artifactDir,
      runId: input.request.runId,
      testKey: input.evidenceKey,
      status: input.status,
      telemetry: input.telemetry,
      redactHeaders: input.request.config.report.redact_headers,
      secretValues: input.secretValues
    });
  }
}

function validateRequestedKeys(tests: BrowserTestDefinition<PlaywrightBrowserTestContext>[], testKeys?: string[]): void {
  if (!testKeys?.length) {
    return;
  }
  const available = new Set(tests.map((test) => test.key));
  const missing = testKeys.filter((key) => !available.has(key));
  if (missing.length > 0) {
    throw new ConfigValidationError("Unknown browser test key.", missing.map((key) => `tests.browser key '${key}' is not registered`));
  }
}

function profileNamesForRun(
  request: BrowserTestRequest,
  tests: BrowserTestDefinition<PlaywrightBrowserTestContext>[],
  defaultProfile: string
): string[] {
  const names = new Set<string>([defaultProfile]);
  if (request.profile) {
    names.add(request.profile);
  }
  for (const test of tests) {
    if (test.profile) {
      names.add(test.profile);
    }
  }
  return [...names].sort();
}

function toMetadata(test: BrowserTestDefinition<PlaywrightBrowserTestContext>): BrowserTestMetadata {
  const { run: _run, ...metadata } = test;
  return metadata;
}

function blockedDependency(test: BrowserTestDefinition<PlaywrightBrowserTestContext>, results: Map<string, NormalizedResult>): NormalizedResult | undefined {
  for (const dependency of test.dependencies) {
    const result = results.get(dependency);
    if (!result || result.status !== "PASS") {
      return (
        result ?? {
          testKey: dependency,
          status: "BLOCKED",
          error: "Dependency was not executed."
        } as NormalizedResult
      );
    }
  }
  return undefined;
}

function evidenceKeyForTest(test: BrowserTestDefinition<PlaywrightBrowserTestContext>): string {
  if (test.key === "auth.valid-login" && test.profile) {
    return `auth.${test.profile}.login`;
  }
  return test.key;
}

function browserTestResult(input: {
  request: BrowserTestRequest;
  test: BrowserTestDefinition<PlaywrightBrowserTestContext>;
  startedAt: string;
  durationMs: number;
  targetRef: string;
  status: NormalizedResult["status"];
  expected: unknown;
  actual: unknown;
  error?: string;
  evidenceRefs: EvidenceRef[];
}): NormalizedResult {
  return {
    id: randomUUID(),
    runId: input.request.runId,
    testKey: input.test.key,
    layer: "browser",
    title: input.test.title,
    status: input.status,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    targetRef: input.targetRef,
    roleProfile: input.test.profile,
    priority: input.test.priority,
    tags: input.test.tags,
    dependencies: input.test.dependencies,
    error: input.error,
    expected: input.expected,
    actual: input.actual,
    evidenceRefs: input.evidenceRefs,
    findingRefs: [],
    adapterId: adapterId(),
    adapterVersion: adapterVersion()
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Browser test timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function dedupeEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  return [...new Map(evidence.map((item) => [item.id, item])).values()];
}
