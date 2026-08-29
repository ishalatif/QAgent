import type { BrowserContext } from "playwright";
import type { ApiEndpoint, EvidenceRef, Finding, DiscoveredPage } from "#contracts";
import type { CloudDiscoveryRequest } from "#core";
import { writeDiscoveryArtifact } from "./evidence.js";
import { attachEvidenceToFindings } from "./finding.js";
import { observePage } from "./network-collector.js";
import { inspectPage } from "./page-inspection.js";
import type { CrawlResult, DiscoveryOptions, EndpointAccumulator, QueuedPage } from "./types.js";
import { isCrawlableUrl, normalizePageUrl, resolveUrl } from "./url-utils.js";

export async function crawlPages(input: {
  context: BrowserContext;
  request: CloudDiscoveryRequest;
  options: DiscoveryOptions;
}): Promise<CrawlResult> {
  const pages: DiscoveredPage[] = [];
  const endpointMap = new Map<string, EndpointAccumulator>();
  const findings: Finding[] = [];
  const evidence: EvidenceRef[] = [];
  const queue: QueuedPage[] = [
    {
      url: input.request.url,
      normalizedUrl: normalizePageUrl(input.request.url),
      depth: 0
    }
  ];
  const queued = new Set(queue.map((item) => item.normalizedUrl));
  const visited = new Set<string>();

  while (queue.length > 0 && visited.size < input.request.config.discovery.max_pages) {
    const current = queue.shift() as QueuedPage;
    if (visited.has(current.normalizedUrl)) {
      continue;
    }
    visited.add(current.normalizedUrl);

    const page = await input.context.newPage();
    const observation = observePage({
      runId: input.request.runId,
      page,
      endpoints: endpointMap,
      findings,
      redactHeaders: input.request.config.report.redact_headers
    });

    const inspected = await inspectPage({
      runId: input.request.runId,
      page,
      queuedPage: current,
      observation,
      artifactDir: input.request.artifactDir,
      redactHeaders: input.request.config.report.redact_headers,
      options: input.options
    });
    pages.push(inspected.page);
    evidence.push(...inspected.evidence);

    enqueueLinks({
      current,
      links: inspected.links,
      queue,
      queued,
      visited,
      request: input.request
    });

    await page.close();
  }

  const apiEndpoints = endpointMapToApiEndpoints(endpointMap);
  const discoveryEvidence = writeDiscoveryArtifact(input.request.artifactDir, input.request.runId, {
    summary: summarizeDiscovery({ pages, findings }),
    pages,
    apiEndpoints,
    findings
  });
  evidence.push(discoveryEvidence);

  return {
    pages,
    apiEndpoints,
    findings: attachEvidenceToFindings(findings, [discoveryEvidence]),
    evidence
  };
}

function enqueueLinks(input: {
  current: QueuedPage;
  links: string[];
  queue: QueuedPage[];
  queued: Set<string>;
  visited: Set<string>;
  request: CloudDiscoveryRequest;
}): void {
  if (input.current.depth >= input.request.config.discovery.max_depth) {
    return;
  }

  for (const href of input.links) {
    if (!isCrawlableUrl(href, input.current.url, input.request.config)) {
      continue;
    }

    const absolute = resolveUrl(href, input.current.url);
    const normalized = normalizePageUrl(absolute);
    if (input.visited.has(normalized) || input.queued.has(normalized)) {
      continue;
    }

    if (input.visited.size + input.queue.length >= input.request.config.discovery.max_pages) {
      break;
    }

    input.queued.add(normalized);
    input.queue.push({
      url: absolute,
      normalizedUrl: normalized,
      depth: input.current.depth + 1,
      sourceUrl: input.current.normalizedUrl
    });
  }
}

function endpointMapToApiEndpoints(endpointMap: Map<string, EndpointAccumulator>): ApiEndpoint[] {
  return [...endpointMap.values()].map((endpoint) => ({
    ...endpoint,
    statusCodes: [...endpoint.statusCodes].sort((a, b) => a - b)
  }));
}

function summarizeDiscovery(input: { pages: DiscoveredPage[]; findings: Finding[] }): Record<string, number> {
  return {
    pagesDiscovered: input.pages.length,
    linksDiscovered: input.pages.reduce((sum, page) => sum + page.linkCount, 0),
    formsDiscovered: input.pages.reduce((sum, page) => sum + page.formCount, 0),
    buttonsDiscovered: input.pages.reduce((sum, page) => sum + page.buttonCount, 0),
    consoleErrors: input.pages.reduce((sum, page) => sum + page.consoleErrors.length, 0),
    networkFailures: input.pages.reduce((sum, page) => sum + page.networkErrors.length, 0),
    brokenLinks: input.findings.filter((finding) => finding.category === "broken-link").length,
    redirects: input.pages.reduce((sum, page) => sum + page.redirectCount, 0),
    navigationFailures: input.findings.filter((finding) => finding.category === "navigation-error" || finding.category === "navigation-timeout").length
  };
}
