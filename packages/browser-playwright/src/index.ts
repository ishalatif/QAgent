import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import type { EvidenceRef } from "#contracts";
import type { CloudDiscoveryAdapter, CloudDiscoveryOutput, CloudDiscoveryRequest } from "#core";
import { crawlPages } from "./crawler.js";
import { evidenceRefFromFile } from "./evidence.js";
import { attachEvidenceToFindings } from "./finding.js";
import { adapterId, adapterVersion, mapDiscoveryResults } from "./result-mapper.js";
import type { DiscoveryOptions } from "./types.js";

export { PlaywrightBrowserTestAdapter, type BrowserTestRunnerOptions } from "./browser-test-runner.js";
export { authProfileReport, PlaywrightAuthActionsImpl, sessionStatePath } from "./auth.js";
export { createDefaultBrowserTestRegistry } from "./registered-tests.js";
export { discoverySummary } from "./result-mapper.js";
export type { DiscoveryOptions } from "./types.js";
export { isCrawlableUrl, matchesExcludedPath, normalizeEndpointPath, normalizePageUrl, safeUrlForReport } from "./url-utils.js";

export class PlaywrightCloudDiscoveryAdapter implements CloudDiscoveryAdapter {
  readonly id = adapterId();
  readonly version = adapterVersion();

  constructor(private readonly options: DiscoveryOptions = {}) {}

  async discover(request: CloudDiscoveryRequest): Promise<CloudDiscoveryOutput> {
    const startedAt = new Date().toISOString();
    mkdirSync(request.artifactDir, { recursive: true });

    const browser = await chromium.launch({ headless: this.options.headless ?? true });
    try {
      const context = await browser.newContext({
        userAgent: "QAgent/0.1.0 Automated QA Runner"
      });
      try {
        const traceStarted = request.config.report.evidence_on !== "never";
        if (traceStarted) {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        }
        const crawlResult = await crawlPages({ context, request, options: this.options });
        const hasFailures = crawlResult.findings.some((finding) => finding.severity !== "Info");
        const trace = traceStarted
          ? await stopDiscoveryTrace({
              context,
              request,
              keep: request.config.report.evidence_on === "always" || hasFailures
            })
          : undefined;
        const evidence = trace ? [...crawlResult.evidence, trace] : crawlResult.evidence;
        const findings = trace && hasFailures ? attachEvidenceToFindings(crawlResult.findings, [trace]) : crawlResult.findings;
        return {
          ...crawlResult,
          findings,
          evidence,
          sourceCommands: [],
          authProfiles: [],
          registeredTests: [],
          results: mapDiscoveryResults({
            request,
            durationMs: elapsedMs(startedAt, new Date().toISOString()),
            pages: crawlResult.pages,
            apiEndpoints: crawlResult.apiEndpoints,
            findings,
            evidence
          })
        };
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
}

function elapsedMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

async function stopDiscoveryTrace(input: {
  context: BrowserContext;
  request: CloudDiscoveryRequest;
  keep: boolean;
}): Promise<EvidenceRef | undefined> {
  if (!input.keep) {
    await input.context.tracing.stop().catch(() => undefined);
    return undefined;
  }

  const relativePath = join("traces", "cloud.discovery.trace.zip");
  mkdirSync(join(input.request.artifactDir, "traces"), { recursive: true });
  await input.context.tracing.stop({ path: join(input.request.artifactDir, relativePath) });
  return evidenceRefFromFile({
    artifactDir: input.request.artifactDir,
    runId: input.request.runId,
    type: "trace",
    relativePath
  });
}
