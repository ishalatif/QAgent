import type { ConsoleMessage, Page, Request, Response } from "playwright";
import type { Finding } from "#contracts";
import { redactText } from "#core";
import { createFinding } from "./finding.js";
import { now, stableRecordId } from "./ids.js";
import type { EndpointAccumulator, PageObservation } from "./types.js";
import { normalizeEndpointPath, safeUrlForReport } from "./url-utils.js";

export function observePage(input: {
  runId: string;
  page: Page;
  endpoints: Map<string, EndpointAccumulator>;
  findings: Finding[];
  redactHeaders: string[];
}): PageObservation {
  const observation: PageObservation = {
    consoleErrors: [],
    networkErrors: [],
    responseStatusByUrl: new Map(),
    endpoints: input.endpoints,
    findings: input.findings
  };

  input.page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") {
      return;
    }

    const text = redactText(message.text(), input.redactHeaders);
    if (/^Failed to load resource:/i.test(text)) {
      return;
    }

    observation.consoleErrors.push(text);
    input.findings.push(
      createFinding({
        runId: input.runId,
        category: "browser-console",
        severity: "Medium",
        title: "Browser console error",
        description: text,
        url: safeUrlForReport(input.page.url())
      })
    );
  });

  input.page.on("pageerror", (error) => {
    const text = redactText(error.message, input.redactHeaders);
    observation.consoleErrors.push(text);
    input.findings.push(
      createFinding({
        runId: input.runId,
        category: "browser-runtime",
        severity: "Medium",
        title: "Browser runtime error",
        description: text,
        url: safeUrlForReport(input.page.url())
      })
    );
  });

  input.page.on("response", (response: Response) => {
    if (!isHttpUrl(response.url())) {
      return;
    }

    const status = response.status();
    observation.responseStatusByUrl.set(response.url(), status);
    upsertEndpoint(input.runId, input.endpoints, response.request().method(), response.url(), status);
    if (status >= 400) {
      input.findings.push(
        createFinding({
          runId: input.runId,
          category: "http-response",
          severity: status >= 500 ? "High" : "Low",
          title: `HTTP ${status} response observed`,
          description: `Browser discovery observed HTTP ${status} for ${normalizeEndpointPath(response.url())}.`,
          url: safeUrlForReport(response.url()),
          method: response.request().method(),
          endpoint: normalizeEndpointPath(response.url())
        })
      );
    }
  });

  input.page.on("requestfailed", (request: Request) => {
    if (!isHttpUrl(request.url())) {
      return;
    }

    const failureText = request.failure()?.errorText ?? "unknown error";
    if (failureText.includes("net::ERR_ABORTED")) {
      return;
    }

    const text = redactText(`${request.method()} ${safeUrlForReport(request.url())} failed: ${failureText}`, input.redactHeaders);
    observation.networkErrors.push(text);
    upsertEndpoint(input.runId, input.endpoints, request.method(), request.url(), 0);
    input.findings.push(
      createFinding({
        runId: input.runId,
        category: "network-failure",
        severity: "Medium",
        title: "Network request failed",
        description: text,
        url: safeUrlForReport(request.url()),
        method: request.method(),
        endpoint: normalizeEndpointPath(request.url())
      })
    );
  });

  return observation;
}

function upsertEndpoint(runId: string, endpoints: Map<string, EndpointAccumulator>, method: string, rawUrl: string, statusCode?: number): void {
  const normalizedPath = normalizeEndpointPath(rawUrl);
  const key = `${method.toUpperCase()} ${normalizedPath}`;
  const seenAt = now();
  const current =
    endpoints.get(key) ??
    ({
      id: stableRecordId(runId, "endpoint", key),
      runId,
      method: method.toUpperCase(),
      normalizedPath,
      statusCodes: new Set<number>(),
      count: 0,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt
    } satisfies EndpointAccumulator);

  current.count += 1;
  current.lastSeenAt = seenAt;
  if (statusCode !== undefined) {
    current.statusCodes.add(statusCode);
  }
  endpoints.set(key, current);
}

function isHttpUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
