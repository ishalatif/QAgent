import { randomUUID } from "node:crypto";
import type { ApiEndpoint, DiscoveredPage, EvidenceRef, Finding, NormalizedResult } from "#contracts";
import type { CloudDiscoveryRequest } from "#core";
import { now } from "./ids.js";

const ADAPTER_ID = "browser-playwright";
const ADAPTER_VERSION = "0.1.0";

export function adapterId(): string {
  return ADAPTER_ID;
}

export function adapterVersion(): string {
  return ADAPTER_VERSION;
}

export function mapDiscoveryResults(input: {
  request: CloudDiscoveryRequest;
  durationMs: number;
  pages: DiscoveredPage[];
  apiEndpoints: ApiEndpoint[];
  findings: Finding[];
  evidence: EvidenceRef[];
}): NormalizedResult[] {
  const summary = discoverySummary(input.pages, input.findings);
  const hasFailures = input.findings.some((finding) => finding.severity !== "Info");

  return [
    normalizedResult({
      runId: input.request.runId,
      testKey: "cloud.discovery.crawl",
      title: "Playwright same-origin discovery",
      status: hasFailures ? "FAIL" : "PASS",
      durationMs: input.durationMs,
      targetRef: input.request.url,
      expected: {
        maxPages: input.request.config.discovery.max_pages,
        maxDepth: input.request.config.discovery.max_depth,
        sameOriginOnly: input.request.config.discovery.same_origin_only
      },
      actual: summary,
      evidenceRefs: input.evidence,
      findingRefs: input.findings.map((finding) => finding.id)
    }),
    normalizedResult({
      runId: input.request.runId,
      testKey: "cloud.discovery.pages",
      title: "Discovered pages inventory",
      status: input.pages.length > 0 && summary.navigationFailures === 0 ? "PASS" : "BLOCKED",
      durationMs: 0,
      targetRef: input.request.url,
      expected: "at least one reachable page",
      actual: {
        pagesVisited: input.pages.length,
        urls: input.pages.map((page) => page.normalizedUrl)
      },
      evidenceRefs: input.evidence,
      findingRefs: input.findings
        .filter((finding) => finding.category === "navigation-error" || finding.category === "navigation-timeout")
        .map((finding) => finding.id)
    }),
    normalizedResult({
      runId: input.request.runId,
      testKey: "api.inventory.observed",
      title: "Observed HTTP/API inventory",
      status: input.apiEndpoints.length > 0 ? "PASS" : "SKIPPED",
      durationMs: 0,
      targetRef: input.request.url,
      expected: "HTTP traffic observed during browser discovery",
      actual: {
        endpoints: input.apiEndpoints.length
      },
      evidenceRefs: input.evidence,
      findingRefs: []
    })
  ];
}

export function discoverySummary(pages: DiscoveredPage[], findings: Finding[]): Record<string, number> {
  return {
    pagesDiscovered: pages.length,
    linksDiscovered: pages.reduce((sum, page) => sum + page.linkCount, 0),
    formsDiscovered: pages.reduce((sum, page) => sum + page.formCount, 0),
    buttonsDiscovered: pages.reduce((sum, page) => sum + page.buttonCount, 0),
    consoleErrors: pages.reduce((sum, page) => sum + page.consoleErrors.length, 0),
    networkFailures: pages.reduce((sum, page) => sum + page.networkErrors.length, 0),
    brokenLinks: findings.filter((finding) => finding.category === "broken-link").length,
    redirects: pages.reduce((sum, page) => sum + page.redirectCount, 0),
    navigationFailures: findings.filter((finding) => finding.category === "navigation-error" || finding.category === "navigation-timeout").length
  };
}

function normalizedResult(input: Omit<NormalizedResult, "id" | "layer" | "startedAt" | "adapterId" | "adapterVersion">): NormalizedResult {
  return {
    ...input,
    id: randomUUID(),
    layer: input.testKey.startsWith("api.") ? "api" : "browser",
    startedAt: now(),
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION
  };
}
