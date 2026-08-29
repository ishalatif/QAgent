import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComparisonReportOutput, NormalizedResult, RegressionComparison, ReportOutput, RunReportData } from "#contracts";
import { writeXlsxFile, type XlsxSheet } from "./xlsx.js";

export class FileReporter {
  async writeReports(data: RunReportData): Promise<ReportOutput> {
    mkdirSync(data.run.artifactDir, { recursive: true });

    const output: ReportOutput = {
      runId: data.run.id,
      rootDir: data.run.artifactDir
    };

    if (data.project && data.run) {
      const jsonPath = join(data.run.artifactDir, "report.json");
      writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      output.jsonPath = jsonPath;
    }

    const htmlPath = join(data.run.artifactDir, "report.html");
    writeFileSync(htmlPath, renderHtml(data), "utf8");
    output.htmlPath = htmlPath;

    const junitPath = join(data.run.artifactDir, "junit.xml");
    writeFileSync(junitPath, renderJUnit(data), "utf8");
    output.junitPath = junitPath;

    const xlsxPath = join(data.run.artifactDir, "report.xlsx");
    writeXlsxFile(xlsxPath, runWorkbookSheets(data));
    output.xlsxPath = xlsxPath;

    return output;
  }

  async writeComparisonReports(comparison: RegressionComparison, rootDir: string): Promise<ComparisonReportOutput> {
    const comparisonRoot = join(rootDir, comparison.id);
    mkdirSync(comparisonRoot, { recursive: true });

    const jsonPath = join(comparisonRoot, "comparison.json");
    const htmlPath = join(comparisonRoot, "comparison.html");
    const xlsxPath = join(comparisonRoot, "comparison.xlsx");
    writeFileSync(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    writeFileSync(htmlPath, renderComparisonHtml(comparison), "utf8");
    writeXlsxFile(xlsxPath, comparisonWorkbookSheets(comparison));

    return {
      comparisonId: comparison.id,
      rootDir: comparisonRoot,
      jsonPath,
      htmlPath,
      xlsxPath
    };
  }
}

export function renderHtml(data: RunReportData): string {
  const rows = data.results
    .map(
      (result) => `<tr>
  <td>${escapeHtml(result.status)}</td>
  <td>${escapeHtml(result.layer)}</td>
  <td>${escapeHtml(result.testKey)}</td>
  <td>${escapeHtml(result.title)}</td>
  <td>${escapeHtml(result.roleProfile ?? "")}</td>
  <td>${escapeHtml(result.priority ?? "")}</td>
  <td>${escapeHtml((result.tags ?? []).join(", "))}</td>
  <td>${escapeHtml(result.targetRef)}</td>
  <td>${escapeHtml(String(result.durationMs))}</td>
  <td>${escapeHtml(formatValue(result.expected))}</td>
  <td>${escapeHtml(formatValue(result.actual))}</td>
  <td>${escapeHtml(result.evidenceRefs.map((item) => item.relativePath).join(", "))}</td>
  <td>${escapeHtml(dependencyReason(result))}</td>
</tr>`
    )
    .join("\n");
  const authProfileRows = data.authProfiles
    .map(
      (profile) => `<tr>
  <td>${escapeHtml(profile.name)}</td>
  <td>${escapeHtml(profile.loginUrl)}</td>
  <td>${escapeHtml(profile.usernameRef)}</td>
  <td>${escapeHtml(formatValue(profile.success))}</td>
  <td>${escapeHtml(profile.sessionArtifact ?? "")}</td>
</tr>`
    )
    .join("\n");
  const registeredTestRows = data.registeredTests
    .map(
      (test) => `<tr>
  <td>${escapeHtml(test.key)}</td>
  <td>${escapeHtml(test.title)}</td>
  <td>${escapeHtml(test.profile ?? "")}</td>
  <td>${escapeHtml(test.priority)}</td>
  <td>${escapeHtml(test.tags.join(", "))}</td>
  <td>${escapeHtml(test.dependencies.join(", "))}</td>
  <td>${String(test.timeoutMs)}</td>
</tr>`
    )
    .join("\n");
  const pageRows = data.pages
    .map(
      (page) => `<tr>
  <td>${escapeHtml(page.normalizedUrl)}</td>
  <td>${escapeHtml(page.finalUrl ?? "")}</td>
  <td>${escapeHtml(String(page.statusCode ?? ""))}</td>
  <td>${escapeHtml(page.title ?? "")}</td>
  <td>${String(page.linkCount)}</td>
  <td>${String(page.formCount)}</td>
  <td>${String(page.buttonCount)}</td>
  <td>${String(page.redirectCount)}</td>
  <td>${String(page.consoleErrors.length)}</td>
  <td>${String(page.networkErrors.length)}</td>
</tr>`
    )
    .join("\n");
  const endpointRows = data.apiEndpoints
    .map(
      (endpoint) => `<tr>
  <td>${escapeHtml(endpoint.method)}</td>
  <td>${escapeHtml(endpoint.normalizedPath)}</td>
  <td>${escapeHtml(endpoint.statusCodes.join(", "))}</td>
  <td>${String(endpoint.count)}</td>
</tr>`
    )
    .join("\n");
  const findingRows = data.findings
    .map(
      (finding) => `<tr>
  <td>${escapeHtml(finding.severity)}</td>
  <td>${escapeHtml(finding.category)}</td>
  <td>${escapeHtml(finding.title)}</td>
  <td>${escapeHtml(finding.url ?? finding.endpoint ?? "")}</td>
</tr>`
    )
    .join("\n");
  const browserSummary = renderBrowserDiscoverySummary(data);
  const sourceSummary = renderSourceProjectSummary(data);
  const sourceCapabilityRows = renderSourceCapabilityRows(data);
  const sourceCommandRows = renderSourceCommandRows(data);
  const apiRbacSummary = renderApiRbacSummary(data);
  const accessibilitySummary = renderAccessibilitySummary(data);
  const accessibilityRows = renderAccessibilityRows(data);
  const performanceSummary = renderPerformanceSummary(data);
  const performanceRows = renderPerformanceRows(data);
  const securitySummary = renderSecuritySummary(data);
  const securityRows = renderSecurityRows(data);
  const loadSummary = renderLoadSummary(data);
  const loadRows = renderLoadRows(data);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QAgent Report ${escapeHtml(data.run.id)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Arial, sans-serif; }
    body { margin: 32px; line-height: 1.5; }
    table { border-collapse: collapse; width: 100%; margin-top: 24px; }
    th, td { border: 1px solid #8a8a8a; padding: 8px; text-align: left; vertical-align: top; }
    th { background: rgba(120, 120, 120, 0.18); }
    .summary { display: flex; gap: 16px; flex-wrap: wrap; }
    .summary div { border: 1px solid #8a8a8a; padding: 8px 12px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>QAgent Report</h1>
  <p><strong>Project:</strong> ${escapeHtml(data.project.name)}</p>
  <p><strong>Run:</strong> ${escapeHtml(data.run.id)} (${escapeHtml(data.run.status)})</p>
  <p><strong>Target:</strong> ${escapeHtml(data.target.url ?? data.target.sourcePath ?? "unknown")}</p>
  <section class="summary" aria-label="Quality gate summary">
    <div>Passed: ${String(data.summary.passed)}</div>
    <div>Total: ${String(data.summary.total)}</div>
    <div>Pass: ${String(data.summary.pass)}</div>
    <div>Fail: ${String(data.summary.fail)}</div>
    <div>Error: ${String(data.summary.error)}</div>
    <div>Blocked: ${String(data.summary.blocked)}</div>
    <div>Skipped: ${String(data.summary.skipped)}</div>
  </section>
  <h2>Browser Discovery Summary</h2>
  <section class="summary" aria-label="Browser discovery summary">
${browserSummary}
  </section>
  <h2>Source Runtime Summary</h2>
  <section class="summary" aria-label="Source runtime summary">
${sourceSummary}
  </section>
  <h2>API/RBAC Summary</h2>
  <section class="summary" aria-label="API and RBAC summary">
${apiRbacSummary}
  </section>
  <h2>Accessibility Summary</h2>
  <section class="summary" aria-label="Accessibility summary">
${accessibilitySummary}
  </section>
  <h2>Performance Summary</h2>
  <section class="summary" aria-label="Performance summary">
${performanceSummary}
  </section>
  <table>
    <caption>Performance Measurements</caption>
    <thead>
      <tr><th>Status</th><th>Page</th><th>First Byte ms</th><th>DOM Content Loaded ms</th><th>Load Event ms</th><th>Transfer Bytes</th><th>Resources</th><th>Breaches</th><th>Evidence</th></tr>
    </thead>
    <tbody>
${performanceRows}
    </tbody>
  </table>
  <h2>Security Summary</h2>
  <section class="summary" aria-label="Security summary">
${securitySummary}
  </section>
  <table>
    <caption>Passive Security Findings</caption>
    <thead>
      <tr><th>Severity</th><th>Check</th><th>Page</th><th>Title</th><th>Evidence</th><th>Remediation</th></tr>
    </thead>
    <tbody>
${securityRows}
    </tbody>
  </table>
  <h2>Load Summary</h2>
  <section class="summary" aria-label="Load summary">
${loadSummary}
  </section>
  <table>
    <caption>HTTP Load Smoke Measurements</caption>
    <thead>
      <tr><th>Status</th><th>Page</th><th>Total Requests</th><th>Failed Requests</th><th>Error Rate</th><th>Average ms</th><th>P95 ms</th><th>Breaches</th><th>Evidence</th></tr>
    </thead>
    <tbody>
${loadRows}
    </tbody>
  </table>
  <table>
    <caption>Accessibility Violations</caption>
    <thead>
      <tr><th>Severity</th><th>Rule</th><th>Page</th><th>Selector</th><th>Description</th><th>Help</th><th>Evidence</th></tr>
    </thead>
    <tbody>
${accessibilityRows}
    </tbody>
  </table>
  <table>
    <caption>Source Capabilities</caption>
    <thead>
      <tr><th>Name</th><th>State</th><th>Command</th><th>Reason</th></tr>
    </thead>
    <tbody>
${sourceCapabilityRows}
    </tbody>
  </table>
  <table>
    <caption>Source Commands</caption>
    <thead>
      <tr><th>Capability</th><th>Status</th><th>Command</th><th>Exit</th><th>Duration ms</th><th>Stdout</th><th>Stderr</th><th>Reason</th></tr>
    </thead>
    <tbody>
${sourceCommandRows}
    </tbody>
  </table>
  <table>
    <caption>Auth Profiles</caption>
    <thead>
      <tr><th>Name</th><th>Login URL</th><th>Username Ref</th><th>Success</th><th>Session Artifact</th></tr>
    </thead>
    <tbody>
${authProfileRows}
    </tbody>
  </table>
  <table>
    <caption>Registered Browser Tests</caption>
    <thead>
      <tr><th>Key</th><th>Title</th><th>Profile</th><th>Priority</th><th>Tags</th><th>Dependencies</th><th>Timeout ms</th></tr>
    </thead>
    <tbody>
${registeredTestRows}
    </tbody>
  </table>
  <table>
    <caption>Results</caption>
    <thead>
      <tr><th>Status</th><th>Layer</th><th>Test Key</th><th>Title</th><th>Profile</th><th>Priority</th><th>Tags</th><th>Target</th><th>Duration ms</th><th>Expected</th><th>Actual</th><th>Evidence</th><th>Dependency Reason</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <table>
    <caption>Discovered Pages</caption>
    <thead>
      <tr><th>URL</th><th>Final URL</th><th>Status</th><th>Title</th><th>Links</th><th>Forms</th><th>Buttons</th><th>Redirects</th><th>Console Errors</th><th>Network Failures</th></tr>
    </thead>
    <tbody>
${pageRows}
    </tbody>
  </table>
  <table>
    <caption>Observed API/HTTP Endpoints</caption>
    <thead>
      <tr><th>Method</th><th>Path</th><th>Status Codes</th><th>Count</th></tr>
    </thead>
    <tbody>
${endpointRows}
    </tbody>
  </table>
  <table>
    <caption>Findings</caption>
    <thead>
      <tr><th>Severity</th><th>Category</th><th>Title</th><th>Target</th></tr>
    </thead>
    <tbody>
${findingRows}
    </tbody>
  </table>
</body>
</html>
`;
}

export function renderJUnit(data: RunReportData): string {
  const cases = data.results.map(renderJUnitCase).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="qagent.${escapeXml(data.project.name)}" tests="${data.summary.total}" failures="${data.summary.fail}" errors="${data.summary.error}" skipped="${data.summary.skipped + data.summary.blocked}" time="${(data.summary.durationMs / 1000).toFixed(3)}">
${cases}
</testsuite>
`;
}

export function renderComparisonHtml(comparison: RegressionComparison): string {
  const entryRows = comparison.entries
    .map(
      (entry) => `<tr>
  <td>${escapeHtml(entry.classification)}</td>
  <td>${escapeHtml(entry.testKey)}</td>
  <td>${escapeHtml(entry.title)}</td>
  <td>${escapeHtml(entry.layer ?? "")}</td>
  <td>${escapeHtml(entry.roleProfile ?? "")}</td>
  <td>${escapeHtml(entry.baselineStatus ?? "")}</td>
  <td>${escapeHtml(entry.currentStatus ?? "")}</td>
  <td>${escapeHtml(entry.baselineError ?? "")}</td>
  <td>${escapeHtml(entry.currentError ?? "")}</td>
</tr>`
    )
    .join("\n");
  const findingRows = comparison.findingEntries
    .map(
      (entry) => `<tr>
  <td>${escapeHtml(entry.classification)}</td>
  <td>${escapeHtml(entry.category)}</td>
  <td>${escapeHtml(entry.title)}</td>
  <td>${escapeHtml(entry.baselineSeverity ?? "")}</td>
  <td>${escapeHtml(entry.currentSeverity ?? "")}</td>
  <td>${escapeHtml(entry.baselineTarget ?? "")}</td>
  <td>${escapeHtml(entry.currentTarget ?? "")}</td>
  <td>${escapeHtml(entry.fingerprint)}</td>
</tr>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QAgent Regression ${escapeHtml(comparison.id)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Arial, sans-serif; }
    body { margin: 32px; line-height: 1.5; }
    table { border-collapse: collapse; width: 100%; margin-top: 24px; }
    th, td { border: 1px solid #8a8a8a; padding: 8px; text-align: left; vertical-align: top; }
    th { background: rgba(120, 120, 120, 0.18); }
    .summary { display: flex; gap: 16px; flex-wrap: wrap; }
    .summary div { border: 1px solid #8a8a8a; padding: 8px 12px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>QAgent Regression Comparison</h1>
  <p><strong>Project:</strong> ${escapeHtml(comparison.project.name)}</p>
  <p><strong>Baseline:</strong> ${escapeHtml(comparison.baseline.name)} (${escapeHtml(comparison.baselineRun.id)})</p>
  <p><strong>Current:</strong> ${escapeHtml(comparison.currentRun.id)}</p>
  <section class="summary" aria-label="Regression summary">
    <div>Passed: ${String(comparison.summary.passed)}</div>
    <div>Regressions: ${String(comparison.summary.regressions)}</div>
    <div>New failures: ${String(comparison.summary.newFailures)}</div>
    <div>Resolved failures: ${String(comparison.summary.resolvedFailures)}</div>
    <div>Status changed: ${String(comparison.summary.statusChanged)}</div>
    <div>Missing tests: ${String(comparison.summary.missingTests)}</div>
    <div>Added tests: ${String(comparison.summary.addedTests)}</div>
    <div>New findings: ${String(comparison.summary.newFindings)}</div>
    <div>Resolved findings: ${String(comparison.summary.resolvedFindings)}</div>
  </section>
  <table>
    <caption>Regression Diff</caption>
    <thead>
      <tr><th>Classification</th><th>Test Key</th><th>Title</th><th>Layer</th><th>Profile</th><th>Baseline</th><th>Current</th><th>Baseline Error</th><th>Current Error</th></tr>
    </thead>
    <tbody>
${entryRows}
    </tbody>
  </table>
  <table>
    <caption>Finding Diff</caption>
    <thead>
      <tr><th>Classification</th><th>Category</th><th>Title</th><th>Baseline Severity</th><th>Current Severity</th><th>Baseline Target</th><th>Current Target</th><th>Fingerprint</th></tr>
    </thead>
    <tbody>
${findingRows}
    </tbody>
  </table>
</body>
</html>
`;
}

function renderJUnitCase(result: NormalizedResult): string {
  const attrs = `classname="${escapeXml(result.layer)}" name="${escapeXml(result.testKey)}" time="${(result.durationMs / 1000).toFixed(3)}"`;
  if (result.status === "FAIL") {
    return `  <testcase ${attrs}><failure message="${escapeXml(result.title)}">${escapeXml(JSON.stringify(result.actual ?? ""))}</failure></testcase>`;
  }
  if (result.status === "ERROR") {
    return `  <testcase ${attrs}><error message="${escapeXml(result.title)}">${escapeXml(JSON.stringify(result.actual ?? ""))}</error></testcase>`;
  }
  if (result.status === "SKIPPED" || result.status === "BLOCKED") {
    return `  <testcase ${attrs}><skipped message="${escapeXml(result.status)}">${escapeXml(result.title)}</skipped></testcase>`;
  }
  return `  <testcase ${attrs}/>`;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#039;";
      default:
        return char;
    }
  });
}

function escapeXml(input: string): string {
  return escapeHtml(input);
}

function formatValue(input: unknown): string {
  if (input === undefined) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  return JSON.stringify(input);
}

function dependencyReason(result: NormalizedResult): string {
  if (result.status !== "BLOCKED") {
    return "";
  }
  if (result.error) {
    return result.error;
  }
  if (!result.actual || typeof result.actual !== "object") {
    return "";
  }
  const actual = result.actual as { blockedBy?: unknown; reason?: unknown; status?: unknown };
  return [actual.blockedBy ? `blockedBy=${String(actual.blockedBy)}` : "", actual.status ? `status=${String(actual.status)}` : "", actual.reason ? String(actual.reason) : ""]
    .filter(Boolean)
    .join(" ");
}

function renderBrowserDiscoverySummary(data: RunReportData): string {
  const values: Record<string, number> = {
    "Pages discovered": data.pages.length,
    "Links discovered": data.pages.reduce((sum, page) => sum + page.linkCount, 0),
    "Forms discovered": data.pages.reduce((sum, page) => sum + page.formCount, 0),
    "Buttons discovered": data.pages.reduce((sum, page) => sum + page.buttonCount, 0),
    "Console errors": data.pages.reduce((sum, page) => sum + page.consoleErrors.length, 0),
    "Network failures": data.pages.reduce((sum, page) => sum + page.networkErrors.length, 0),
    "Broken links": data.findings.filter((finding) => finding.category === "broken-link").length,
    Redirects: data.pages.reduce((sum, page) => sum + page.redirectCount, 0),
    "Navigation failures": data.findings.filter((finding) => finding.category === "navigation-error" || finding.category === "navigation-timeout").length
  };

  return Object.entries(values)
    .map(([label, value]) => `    <div>${escapeHtml(label)}: ${String(value)}</div>`)
    .join("\n");
}

function renderSourceProjectSummary(data: RunReportData): string {
  if (!data.sourceProject) {
    return "    <div>Source project: none</div>";
  }

  const source = data.sourceProject;
  const values: Record<string, string> = {
    Runtime: source.runtime,
    Framework: source.framework,
    Adapter: source.adapterId,
    Support: source.support,
    Confidence: source.confidence,
    "Package manager": source.packageManager ?? "",
    "Inspect only": String(source.inspectOnly),
    Markers: source.markers.join(", "),
    Reason: source.reason ?? ""
  };

  return Object.entries(values)
    .map(([label, value]) => `    <div>${escapeHtml(label)}: ${escapeHtml(value)}</div>`)
    .join("\n");
}

function renderSourceCapabilityRows(data: RunReportData): string {
  return (
    data.sourceProject?.capabilities
      .map((capability) => {
        const command = capability.command ? `${capability.command.command} ${capability.command.args.join(" ")}`.trim() : "";
        return `<tr>
  <td>${escapeHtml(capability.name)}</td>
  <td>${escapeHtml(capability.state)}</td>
  <td>${escapeHtml(command)}</td>
  <td>${escapeHtml(capability.reason ?? "")}</td>
</tr>`;
      })
      .join("\n") ?? ""
  );
}

function renderSourceCommandRows(data: RunReportData): string {
  return data.sourceCommands
    .map((command) => `<tr>
  <td>${escapeHtml(command.capability)}</td>
  <td>${escapeHtml(command.status)}</td>
  <td>${escapeHtml(`${command.command} ${command.args.join(" ")}`.trim())}</td>
  <td>${escapeHtml(String(command.exitCode ?? ""))}</td>
  <td>${escapeHtml(String(command.durationMs))}</td>
  <td>${escapeHtml(command.stdoutArtifact ?? "")}</td>
  <td>${escapeHtml(command.stderrArtifact ?? "")}</td>
  <td>${escapeHtml(command.reason ?? "")}</td>
</tr>`)
    .join("\n");
}

function renderApiRbacSummary(data: RunReportData): string {
  const apiResults = data.results.filter((result) => result.layer === "api");
  const authorizationResults = data.results.filter((result) => result.layer === "authorization");
  const values: Record<string, number> = {
    "API assertions": apiResults.length,
    "API failures": apiResults.filter((result) => result.status === "FAIL" || result.status === "ERROR").length,
    "RBAC checks": authorizationResults.length,
    "RBAC failures": authorizationResults.filter((result) => result.status === "FAIL" || result.status === "ERROR").length,
    "Authorization bypass findings": data.findings.filter((finding) => finding.category === "authorization-bypass").length
  };

  return Object.entries(values)
    .map(([label, value]) => `    <div>${escapeHtml(label)}: ${String(value)}</div>`)
    .join("\n");
}

function renderAccessibilitySummary(data: RunReportData): string {
  const scanResults = data.results.filter((result) => result.layer === "accessibility" && result.testKey.startsWith("accessibility.axe.") && !result.testKey.endsWith(".adapter"));
  const findings = accessibilityFindings(data);
  const values: Record<string, number> = {
    "Pages scanned": scanResults.filter((result) => result.status === "PASS" || result.status === "FAIL").length,
    "Total violations": findings.length,
    Critical: findings.filter((finding) => finding.severity === "Critical").length,
    High: findings.filter((finding) => finding.severity === "High").length,
    Medium: findings.filter((finding) => finding.severity === "Medium").length,
    Low: findings.filter((finding) => finding.severity === "Low").length,
    Info: findings.filter((finding) => finding.severity === "Info").length
  };

  return Object.entries(values)
    .map(([label, value]) => `    <div>${escapeHtml(label)}: ${String(value)}</div>`)
    .join("\n");
}

function renderAccessibilityRows(data: RunReportData): string {
  return accessibilityFindings(data)
    .map((finding) => {
      const details = finding.details ?? {};
      return `<tr>
  <td>${escapeHtml(finding.severity)}</td>
  <td>${escapeHtml(String(details.ruleId ?? ""))}</td>
  <td>${escapeHtml(finding.url ?? "")}</td>
  <td>${escapeHtml(String(details.selector ?? ""))}</td>
  <td>${escapeHtml(finding.description)}</td>
  <td>${escapeHtml(String(details.help ?? finding.remediationHint ?? ""))}</td>
  <td>${escapeHtml(finding.evidenceRefs.map((item) => item.relativePath).join(", "))}</td>
</tr>`;
    })
    .join("\n");
}

function renderPerformanceSummary(data: RunReportData): string {
  const measurements = performanceMeasurements(data);
  const findings = data.findings.filter((finding) => finding.category === "performance");
  const maxLoadEventMs = measurements.reduce((max, measurement) => Math.max(max, numberFromObject(measurement, "loadEventMs")), 0);
  const maxDomContentLoadedMs = measurements.reduce((max, measurement) => Math.max(max, numberFromObject(measurement, "domContentLoadedMs")), 0);
  const maxFirstByteMs = measurements.reduce((max, measurement) => Math.max(max, numberFromObject(measurement, "firstByteMs")), 0);
  const values: Record<string, number> = {
    "Pages scanned": measurements.length,
    "Performance findings": findings.length,
    "Max first byte ms": maxFirstByteMs,
    "Max DOM content loaded ms": maxDomContentLoadedMs,
    "Max load event ms": maxLoadEventMs
  };

  return Object.entries(values)
    .map(([label, value]) => `    <div>${escapeHtml(label)}: ${String(value)}</div>`)
    .join("\n");
}

function renderPerformanceRows(data: RunReportData): string {
  return data.results
    .filter((result) => result.layer === "performance" && result.testKey.startsWith("performance.browser-timing.public."))
    .map((result) => {
      const actual = objectValue(result.actual);
      const measurement = objectValue(actual.measurement);
      const breaches = Array.isArray(actual.breaches) ? actual.breaches : [];
      const transferBytes = numberFromObject(measurement, "transferSizeBytes") + numberFromObject(measurement, "resourceTransferSizeBytes");
      return `<tr>
  <td>${escapeHtml(result.status)}</td>
  <td>${escapeHtml(String(actual.page ?? result.targetRef))}</td>
  <td>${String(numberFromObject(measurement, "firstByteMs"))}</td>
  <td>${String(numberFromObject(measurement, "domContentLoadedMs"))}</td>
  <td>${String(numberFromObject(measurement, "loadEventMs"))}</td>
  <td>${String(transferBytes)}</td>
  <td>${String(numberFromObject(measurement, "resourceCount"))}</td>
  <td>${escapeHtml(formatValue(breaches))}</td>
  <td>${escapeHtml(result.evidenceRefs.map((item) => item.relativePath).join(", "))}</td>
</tr>`;
    })
    .join("\n");
}

function renderSecuritySummary(data: RunReportData): string {
  const findings = securityFindings(data);
  const scanResults = data.results.filter((result) => result.layer === "security" && result.testKey.startsWith("security.passive-http.public."));
  const values: Record<string, number> = {
    "Pages scanned": scanResults.filter((result) => result.status === "PASS" || result.status === "FAIL").length,
    "Security findings": findings.length,
    Critical: findings.filter((finding) => finding.severity === "Critical").length,
    High: findings.filter((finding) => finding.severity === "High").length,
    Medium: findings.filter((finding) => finding.severity === "Medium").length,
    Low: findings.filter((finding) => finding.severity === "Low").length,
    Info: findings.filter((finding) => finding.severity === "Info").length
  };

  return Object.entries(values)
    .map(([label, value]) => `    <div>${escapeHtml(label)}: ${String(value)}</div>`)
    .join("\n");
}

function renderSecurityRows(data: RunReportData): string {
  return securityFindings(data)
    .map((finding) => {
      const details = finding.details ?? {};
      return `<tr>
  <td>${escapeHtml(finding.severity)}</td>
  <td>${escapeHtml(String(details.check ?? ""))}</td>
  <td>${escapeHtml(finding.url ?? "")}</td>
  <td>${escapeHtml(finding.title)}</td>
  <td>${escapeHtml(formatValue(details.evidence))}</td>
  <td>${escapeHtml(finding.remediationHint ?? "")}</td>
</tr>`;
    })
    .join("\n");
}

function renderLoadSummary(data: RunReportData): string {
  const measurements = loadMeasurements(data);
  const findings = data.findings.filter((finding) => finding.category === "load");
  const values: Record<string, number> = {
    "Pages scanned": measurements.length,
    "Load findings": findings.length,
    "Max error rate": measurements.reduce((max, measurement) => Math.max(max, numberFromObject(measurement, "errorRate")), 0),
    "Max average ms": measurements.reduce((max, measurement) => Math.max(max, numberFromObject(measurement, "averageMs")), 0),
    "Max p95 ms": measurements.reduce((max, measurement) => Math.max(max, numberFromObject(measurement, "p95Ms")), 0)
  };

  return Object.entries(values)
    .map(([label, value]) => `    <div>${escapeHtml(label)}: ${String(value)}</div>`)
    .join("\n");
}

function renderLoadRows(data: RunReportData): string {
  return data.results
    .filter((result) => result.layer === "load" && result.testKey.startsWith("load.http-smoke.public."))
    .map((result) => {
      const actual = objectValue(result.actual);
      const measurement = objectValue(actual.measurement);
      const breaches = Array.isArray(actual.breaches) ? actual.breaches : [];
      return `<tr>
  <td>${escapeHtml(result.status)}</td>
  <td>${escapeHtml(String(actual.page ?? result.targetRef))}</td>
  <td>${String(numberFromObject(measurement, "totalRequests"))}</td>
  <td>${String(numberFromObject(measurement, "failedRequests"))}</td>
  <td>${String(numberFromObject(measurement, "errorRate"))}</td>
  <td>${String(numberFromObject(measurement, "averageMs"))}</td>
  <td>${String(numberFromObject(measurement, "p95Ms"))}</td>
  <td>${escapeHtml(formatValue(breaches))}</td>
  <td>${escapeHtml(result.evidenceRefs.map((item) => item.relativePath).join(", "))}</td>
</tr>`;
    })
    .join("\n");
}

function runWorkbookSheets(data: RunReportData): XlsxSheet[] {
  return [
    {
      name: "Summary",
      rows: [
        ["Project", data.project.name],
        ["Run", data.run.id],
        ["Status", data.run.status],
        ["Target", data.target.url ?? data.target.sourcePath ?? ""],
        ["Passed", data.summary.passed],
        ["Total", data.summary.total],
        ["Pass", data.summary.pass],
        ["Fail", data.summary.fail],
        ["Error", data.summary.error],
        ["Blocked", data.summary.blocked],
        ["Skipped", data.summary.skipped],
        ["Duration ms", data.summary.durationMs]
      ]
    },
    {
      name: "Results",
      rows: [
        ["Status", "Layer", "Test Key", "Title", "Profile", "Priority", "Tags", "Target", "Duration ms", "Expected", "Actual", "Evidence", "Error"],
        ...data.results.map((result) => [
          result.status,
          result.layer,
          result.testKey,
          result.title,
          result.roleProfile ?? "",
          result.priority ?? "",
          (result.tags ?? []).join(", "),
          result.targetRef,
          result.durationMs,
          formatValue(result.expected),
          formatValue(result.actual),
          result.evidenceRefs.map((item) => item.relativePath).join(", "),
          result.error ?? ""
        ])
      ]
    },
    {
      name: "Findings",
      rows: [
        ["Severity", "Category", "Title", "Target", "Method", "Endpoint", "Profile", "Remediation"],
        ...data.findings.map((finding) => [
          finding.severity,
          finding.category,
          finding.title,
          finding.url ?? finding.endpoint ?? "",
          finding.method ?? "",
          finding.endpoint ?? "",
          finding.roleProfile ?? "",
          finding.remediationHint ?? ""
        ])
      ]
    },
    {
      name: "Accessibility",
      rows: [
        ["Severity", "Rule", "Impact", "Page", "Selector", "Description", "Help", "Help URL", "Failure Summary", "Evidence"],
        ...accessibilityFindings(data).map((finding) => {
          const details = finding.details ?? {};
          return [
            finding.severity,
            details.ruleId ?? "",
            details.impact ?? "",
            finding.url ?? "",
            details.selector ?? "",
            finding.description,
            details.help ?? "",
            details.helpUrl ?? finding.remediationHint ?? "",
            details.failureSummary ?? "",
            finding.evidenceRefs.map((item) => item.relativePath).join(", ")
          ];
        })
      ]
    },
    {
      name: "Performance",
      rows: [
        ["Status", "Test Key", "Page", "First Byte ms", "DOM Content Loaded ms", "Load Event ms", "Transfer Bytes", "Resources", "Breaches", "Evidence"],
        ...data.results
          .filter((result) => result.layer === "performance" && result.testKey.startsWith("performance.browser-timing.public."))
          .map((result) => {
            const actual = objectValue(result.actual);
            const measurement = objectValue(actual.measurement);
            const transferBytes = numberFromObject(measurement, "transferSizeBytes") + numberFromObject(measurement, "resourceTransferSizeBytes");
            return [
              result.status,
              result.testKey,
              actual.page ?? result.targetRef,
              numberFromObject(measurement, "firstByteMs"),
              numberFromObject(measurement, "domContentLoadedMs"),
              numberFromObject(measurement, "loadEventMs"),
              transferBytes,
              numberFromObject(measurement, "resourceCount"),
              formatValue(actual.breaches),
              result.evidenceRefs.map((item) => item.relativePath).join(", ")
            ];
          })
      ]
    },
    {
      name: "Security",
      rows: [
        ["Severity", "Check", "Page", "Title", "Description", "Evidence", "Remediation"],
        ...securityFindings(data).map((finding) => {
          const details = finding.details ?? {};
          return [
            finding.severity,
            details.check ?? "",
            finding.url ?? "",
            finding.title,
            finding.description,
            formatValue(details.evidence),
            finding.remediationHint ?? ""
          ];
        })
      ]
    },
    {
      name: "Load",
      rows: [
        ["Status", "Test Key", "Page", "Total Requests", "Failed Requests", "Error Rate", "Average ms", "P95 ms", "Breaches", "Evidence"],
        ...data.results
          .filter((result) => result.layer === "load" && result.testKey.startsWith("load.http-smoke.public."))
          .map((result) => {
            const actual = objectValue(result.actual);
            const measurement = objectValue(actual.measurement);
            return [
              result.status,
              result.testKey,
              actual.page ?? result.targetRef,
              numberFromObject(measurement, "totalRequests"),
              numberFromObject(measurement, "failedRequests"),
              numberFromObject(measurement, "errorRate"),
              numberFromObject(measurement, "averageMs"),
              numberFromObject(measurement, "p95Ms"),
              formatValue(actual.breaches),
              result.evidenceRefs.map((item) => item.relativePath).join(", ")
            ];
          })
      ]
    },
    {
      name: "Pages",
      rows: [
        ["URL", "Final URL", "Status", "Title", "Links", "Forms", "Buttons", "Redirects", "Console Errors", "Network Errors"],
        ...data.pages.map((page) => [
          page.normalizedUrl,
          page.finalUrl ?? "",
          page.statusCode ?? "",
          page.title ?? "",
          page.linkCount,
          page.formCount,
          page.buttonCount,
          page.redirectCount,
          page.consoleErrors.length,
          page.networkErrors.length
        ])
      ]
    },
    {
      name: "API Endpoints",
      rows: [
        ["Method", "Path", "Status Codes", "Count", "First Seen", "Last Seen"],
        ...data.apiEndpoints.map((endpoint) => [
          endpoint.method,
          endpoint.normalizedPath,
          endpoint.statusCodes.join(", "),
          endpoint.count,
          endpoint.firstSeenAt,
          endpoint.lastSeenAt
        ])
      ]
    }
  ];
}

function accessibilityFindings(data: RunReportData): RunReportData["findings"] {
  return data.findings.filter((finding) => finding.category === "accessibility").sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function securityFindings(data: RunReportData): RunReportData["findings"] {
  return data.findings.filter((finding) => finding.category === "security").sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function performanceMeasurements(data: RunReportData): Array<Record<string, unknown>> {
  return data.results
    .filter((result) => result.layer === "performance" && result.testKey.startsWith("performance.browser-timing.public."))
    .map((result) => objectValue(objectValue(result.actual).measurement));
}

function loadMeasurements(data: RunReportData): Array<Record<string, unknown>> {
  return data.results
    .filter((result) => result.layer === "load" && result.testKey.startsWith("load.http-smoke.public."))
    .map((result) => objectValue(objectValue(result.actual).measurement));
}

function objectValue(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function numberFromObject(input: Record<string, unknown>, key: string): number {
  const value = Number(input[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function comparisonWorkbookSheets(comparison: RegressionComparison): XlsxSheet[] {
  return [
    {
      name: "Summary",
      rows: [
        ["Project", comparison.project.name],
        ["Comparison", comparison.id],
        ["Baseline", comparison.baseline.name],
        ["Baseline Run", comparison.baselineRun.id],
        ["Current Run", comparison.currentRun.id],
        ["Passed", comparison.summary.passed],
        ["Baseline Total", comparison.summary.baselineTotal],
        ["Current Total", comparison.summary.currentTotal],
        ["Compared Total", comparison.summary.comparedTotal],
        ["Regressions", comparison.summary.regressions],
        ["Improvements", comparison.summary.improvements],
        ["New Failures", comparison.summary.newFailures],
        ["Resolved Failures", comparison.summary.resolvedFailures],
        ["Status Changed", comparison.summary.statusChanged],
        ["Added Tests", comparison.summary.addedTests],
        ["Missing Tests", comparison.summary.missingTests],
        ["New Findings", comparison.summary.newFindings],
        ["Resolved Findings", comparison.summary.resolvedFindings],
        ["Changed Findings", comparison.summary.changedFindings]
      ]
    },
    {
      name: "Diff",
      rows: [
        ["Classification", "Test Key", "Title", "Layer", "Profile", "Baseline Status", "Current Status", "Baseline Error", "Current Error"],
        ...comparison.entries.map((entry) => [
          entry.classification,
          entry.testKey,
          entry.title,
          entry.layer ?? "",
          entry.roleProfile ?? "",
          entry.baselineStatus ?? "",
          entry.currentStatus ?? "",
          entry.baselineError ?? "",
          entry.currentError ?? ""
        ])
      ]
    },
    {
      name: "Finding Diff",
      rows: [
        ["Classification", "Category", "Title", "Baseline Severity", "Current Severity", "Baseline Target", "Current Target", "Fingerprint"],
        ...comparison.findingEntries.map((entry) => [
          entry.classification,
          entry.category,
          entry.title,
          entry.baselineSeverity ?? "",
          entry.currentSeverity ?? "",
          entry.baselineTarget ?? "",
          entry.currentTarget ?? "",
          entry.fingerprint
        ])
      ]
    }
  ];
}
