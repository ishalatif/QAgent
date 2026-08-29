import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleMessage, Page, Request } from "playwright";
import type { EvidenceRef } from "#contracts";
import { redactObject, redactText } from "#core";
import { sha256, stableRecordId } from "./ids.js";
import { safeUrlForReport } from "./url-utils.js";

export interface BrowserTestTelemetry {
  consoleErrors: string[];
  networkErrors: string[];
}

export function observeBrowserTestPage(page: Page, redactHeaders: string[], secretValues: string[] = []): BrowserTestTelemetry {
  const telemetry: BrowserTestTelemetry = {
    consoleErrors: [],
    networkErrors: []
  };

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") {
      return;
    }
    telemetry.consoleErrors.push(sanitizeText(message.text(), redactHeaders, secretValues));
  });

  page.on("pageerror", (error) => {
    telemetry.consoleErrors.push(sanitizeText(error.message, redactHeaders, secretValues));
  });

  page.on("requestfailed", (request: Request) => {
    const failureText = request.failure()?.errorText ?? "unknown error";
    if (failureText.includes("net::ERR_ABORTED")) {
      return;
    }
    telemetry.networkErrors.push(sanitizeText(`${request.method()} ${safeUrlForReport(request.url())} failed: ${failureText}`, redactHeaders, secretValues));
  });

  return telemetry;
}

export async function captureBrowserTestEvidence(input: {
  page: Page;
  artifactDir: string;
  runId: string;
  testKey: string;
  status: string;
  telemetry: BrowserTestTelemetry;
  redactHeaders: string[];
  secretValues?: string[];
}): Promise<EvidenceRef[]> {
  const secretValues = input.secretValues ?? [];
  const relativeDir = join("evidence", safeFilePart(input.testKey));
  const fullDir = join(input.artifactDir, relativeDir);
  mkdirSync(fullDir, { recursive: true });

  const evidence: EvidenceRef[] = [];
  const screenshotRelativePath = join(relativeDir, "screenshot.png");
  const screenshotPath = join(input.artifactDir, screenshotRelativePath);
  try {
    await input.page.screenshot({ path: screenshotPath, fullPage: true, timeout: 2_000 });
    const content = readFileSync(screenshotPath);
    const stat = statSync(screenshotPath);
    evidence.push({
      id: stableRecordId(input.runId, "evidence", screenshotRelativePath),
      type: "screenshot",
      relativePath: screenshotRelativePath,
      sha256: sha256(content),
      size: stat.size
    });
  } catch {
    // Evidence capture must not turn the browser test into an infrastructure error.
  }

  const traceRelativePath = join(relativeDir, "trace.json");
  const tracePath = join(input.artifactDir, traceRelativePath);
  const tracePayload = sanitizeObject(
    {
      format: "qagent.sanitized-browser-trace.v1",
      testKey: input.testKey,
      status: input.status,
      url: safeUrlForReport(input.page.url()),
      consoleErrors: input.telemetry.consoleErrors,
      networkErrors: input.telemetry.networkErrors
    },
    input.redactHeaders,
    secretValues
  );
  const traceContent = `${JSON.stringify(tracePayload, null, 2)}\n`;
  writeFileSync(tracePath, traceContent, "utf8");
  const traceStat = statSync(tracePath);
  evidence.push({
    id: stableRecordId(input.runId, "evidence", traceRelativePath),
    type: "trace",
    relativePath: traceRelativePath,
    sha256: sha256(traceContent),
    size: traceStat.size
  });

  const contextRelativePath = join(relativeDir, "browser-context.json");
  const contextPath = join(input.artifactDir, contextRelativePath);
  const payload = sanitizeObject(
    {
      url: safeUrlForReport(input.page.url()),
      consoleErrors: input.telemetry.consoleErrors,
      networkErrors: input.telemetry.networkErrors
    },
    input.redactHeaders,
    secretValues
  );
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(contextPath, content, "utf8");
  const stat = statSync(contextPath);
  evidence.push({
    id: stableRecordId(input.runId, "evidence", contextRelativePath),
    type: "json",
    relativePath: contextRelativePath,
    sha256: sha256(content),
    size: stat.size
  });

  return evidence;
}

export function sanitizeError(error: unknown, redactHeaders: string[], secretValues: string[] = []): string {
  return sanitizeText(error instanceof Error ? error.message : String(error), redactHeaders, secretValues);
}

export function sanitizeText(input: string, redactHeaders: string[], secretValues: string[] = []): string {
  let output = redactText(input, redactHeaders);
  for (const secret of secretValues.filter((value) => value.length >= 3)) {
    output = output.split(secret).join("<redacted>");
  }
  return output;
}

function sanitizeObject<T>(input: T, redactHeaders: string[], secretValues: string[]): T {
  return redactExact(redactObject(input, redactHeaders), secretValues) as T;
}

function redactExact(input: unknown, secretValues: string[]): unknown {
  if (typeof input === "string") {
    let output = input;
    for (const secret of secretValues.filter((value) => value.length >= 3)) {
      output = output.split(secret).join("<redacted>");
    }
    return output;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactExact(item, secretValues));
  }
  if (!input || typeof input !== "object") {
    return input;
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, redactExact(value, secretValues)]));
}

function safeFilePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "browser-test";
}
