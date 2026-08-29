import type { Page, Request } from "playwright";
import type { EvidenceRef, Finding } from "#contracts";
import { redactText } from "#core";
import { captureFailureScreenshot } from "./evidence.js";
import { createFinding } from "./finding.js";
import { now, stableRecordId } from "./ids.js";
import type { DiscoveryOptions, PageInspectionResult, PageObservation, QueuedPage } from "./types.js";
import { normalizeEndpointPath, normalizePageUrl, safeUrlForReport } from "./url-utils.js";

export async function inspectPage(input: {
  runId: string;
  page: Page;
  queuedPage: QueuedPage;
  observation: PageObservation;
  artifactDir: string;
  redactHeaders: string[];
  options: DiscoveryOptions;
}): Promise<PageInspectionResult> {
  const discoveredAt = now();
  const pageEvidence: EvidenceRef[] = [];
  let statusCode: number | undefined;
  let finalUrl: string | undefined;
  let title: string | undefined;
  let links: string[] = [];
  let formCount = 0;
  let buttonCount = 0;
  let redirectCount = 0;

  try {
    const response = await input.page.goto(input.queuedPage.url, {
      waitUntil: "domcontentloaded",
      timeout: input.options.navigationTimeoutMs ?? 5000
    });
    statusCode = response?.status();
    finalUrl = safeUrlForReport(input.page.url());
    redirectCount = response ? countRedirects(response.request()) : 0;

    await input.page.waitForLoadState("networkidle", { timeout: input.options.settleTimeoutMs ?? 1200 }).catch(() => undefined);
    title = await input.page.title().catch(() => undefined);
    links = await collectLinks(input.page);
    formCount = await input.page.locator("form").count().catch(() => 0);
    buttonCount = await input.page.locator("button, input[type='button'], input[type='submit'], [role='button']").count().catch(() => 0);

    if (statusCode && statusCode >= 400) {
      const screenshot = await captureFailureScreenshot({
        page: input.page,
        artifactDir: input.artifactDir,
        runId: input.runId,
        url: input.queuedPage.url,
        label: input.queuedPage.sourceUrl ? "broken-link" : "navigation-http-error"
      });
      if (screenshot) {
        pageEvidence.push(screenshot);
      }

      input.observation.findings.push(
        createNavigationFinding({
          runId: input.runId,
          category: input.queuedPage.sourceUrl ? "broken-link" : "navigation-error",
          severity: statusCode >= 500 ? "High" : "Medium",
          title: input.queuedPage.sourceUrl ? `Broken link returned HTTP ${statusCode}` : `Page returned HTTP ${statusCode}`,
          description: [
            `Timestamp: ${now()}`,
            `Error type: http-status`,
            `HTTP status: ${statusCode}`,
            `URL: ${safeUrlForReport(input.queuedPage.url)}`,
            input.queuedPage.sourceUrl ? `Source page: ${safeUrlForReport(input.queuedPage.sourceUrl)}` : undefined
          ]
            .filter(Boolean)
            .join("\n"),
          url: safeUrlForReport(input.queuedPage.url),
          method: "GET",
          evidenceRefs: screenshot ? [screenshot] : []
        })
      );
    }
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error), input.redactHeaders);
    const category = isTimeoutMessage(message) ? "navigation-timeout" : "navigation-error";
    const screenshot = await captureFailureScreenshot({
      page: input.page,
      artifactDir: input.artifactDir,
      runId: input.runId,
      url: input.queuedPage.url,
      label: category
    });
    if (screenshot) {
      pageEvidence.push(screenshot);
    }

    input.observation.networkErrors.push(message);
    input.observation.findings.push(
      createNavigationFinding({
        runId: input.runId,
        category,
        severity: "High",
        title: category === "navigation-timeout" ? "Navigation timed out" : "Navigation failed",
        description: [
          `Timestamp: ${now()}`,
          `Error type: ${category}`,
          `URL: ${safeUrlForReport(input.queuedPage.url)}`,
          `Message: ${message}`
        ].join("\n"),
        url: safeUrlForReport(input.queuedPage.url),
        method: "GET",
        evidenceRefs: screenshot ? [screenshot] : []
      })
    );
  }

  return {
    links,
    evidence: pageEvidence,
    page: {
      id: stableRecordId(input.runId, "page", input.queuedPage.normalizedUrl),
      runId: input.runId,
      url: input.queuedPage.url,
      normalizedUrl: input.queuedPage.normalizedUrl,
      finalUrl,
      statusCode,
      title,
      linkCount: links.length,
      formCount,
      buttonCount,
      redirectCount,
      consoleErrors: input.observation.consoleErrors,
      networkErrors: input.observation.networkErrors,
      discoveredAt
    }
  };
}

async function collectLinks(page: Page): Promise<string[]> {
  return page
    .locator("a[href]")
    .evaluateAll((anchors) =>
      anchors
        .map((anchor) => anchor.getAttribute("href"))
        .filter((href): href is string => Boolean(href))
        .map((href) => new URL(href, (globalThis as unknown as { location: { href: string } }).location.href).toString())
    )
    .catch(() => []);
}

function countRedirects(request: Request): number {
  let count = 0;
  let current: Request | null = request.redirectedFrom();
  while (current) {
    count += 1;
    current = current.redirectedFrom();
  }
  return count;
}

function isTimeoutMessage(message: string): boolean {
  return /timeout|timed out/i.test(message);
}

function createNavigationFinding(
  input: Omit<Finding, "id" | "fingerprint" | "redactionApplied" | "endpoint"> & {
    runId: string;
    method: string;
  }
): Finding {
  return createFinding({
    ...input,
    endpoint: input.url ? normalizeEndpointPath(input.url) : undefined
  });
}
