import { createHash } from "node:crypto";
import type {
  BaselineRecord,
  NormalizedResult,
  RegressionClassification,
  RegressionComparison,
  RegressionComparisonEntry,
  RegressionFindingClassification,
  RegressionFindingComparisonEntry,
  RegressionComparisonSummary,
  ResultStatus,
  RunReportData
} from "#contracts";

export class RegressionComparisonError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "RegressionComparisonError";
    this.issues = issues;
  }
}

export interface CreateRegressionComparisonInput {
  baseline: BaselineRecord;
  baselineReport: RunReportData;
  currentReport: RunReportData;
  comparedAt?: string;
}

export function createRegressionComparison(input: CreateRegressionComparisonInput): RegressionComparison {
  validateComparableReports(input);

  const comparedAt = input.comparedAt ?? new Date().toISOString();
  const baselineResults = resultMap(input.baselineReport.results);
  const currentResults = resultMap(input.currentReport.results);
  const keys = [...new Set([...baselineResults.keys(), ...currentResults.keys()])].sort();
  const entries = keys.map((key) => comparisonEntry(key, baselineResults.get(key), currentResults.get(key)));
  const baselineFindings = findingMap(input.baselineReport.findings);
  const currentFindings = findingMap(input.currentReport.findings);
  const findingKeys = [...new Set([...baselineFindings.keys(), ...currentFindings.keys()])].sort();
  const findingEntries = findingKeys.map((key) => findingComparisonEntry(key, baselineFindings.get(key), currentFindings.get(key)));
  const summary = summarize(entries, findingEntries, input.baselineReport.results.length, input.currentReport.results.length);

  return {
    id: comparisonId(input.baseline.id, input.currentReport.run.id),
    project: input.currentReport.project,
    baseline: input.baseline,
    baselineRun: input.baselineReport.run,
    currentRun: input.currentReport.run,
    comparedAt,
    summary,
    entries,
    findingEntries
  };
}

function validateComparableReports(input: CreateRegressionComparisonInput): void {
  const issues: string[] = [];

  if (input.baseline.runId !== input.baselineReport.run.id) {
    issues.push(`baseline '${input.baseline.name}' references run ${input.baseline.runId}, but report run is ${input.baselineReport.run.id}`);
  }
  if (input.baselineReport.run.status !== "COMPLETED") {
    issues.push(`baseline run ${input.baselineReport.run.id} is not completed`);
  }
  if (input.currentReport.run.status !== "COMPLETED") {
    issues.push(`current run ${input.currentReport.run.id} is not completed`);
  }
  if (input.baselineReport.project.id !== input.currentReport.project.id) {
    issues.push("baseline and current run belong to different projects");
  }
  if (input.baseline.projectId !== input.currentReport.project.id) {
    issues.push(`baseline '${input.baseline.name}' does not belong to project ${input.currentReport.project.id}`);
  }

  if (issues.length > 0) {
    throw new RegressionComparisonError("Unable to compare run against baseline.", issues);
  }
}

function resultMap(results: NormalizedResult[]): Map<string, NormalizedResult> {
  const map = new Map<string, NormalizedResult>();
  for (const result of results) {
    map.set(result.testKey, result);
  }
  return map;
}

function findingMap(findings: RunReportData["findings"]): Map<string, RunReportData["findings"][number]> {
  const map = new Map<string, RunReportData["findings"][number]>();
  for (const finding of findings) {
    map.set(finding.fingerprint, finding);
  }
  return map;
}

function comparisonEntry(testKey: string, baseline?: NormalizedResult, current?: NormalizedResult): RegressionComparisonEntry {
  const classification = classify(baseline?.status, current?.status);
  const representative = current ?? baseline;
  return {
    testKey,
    title: representative?.title ?? testKey,
    layer: representative?.layer,
    roleProfile: current?.roleProfile ?? baseline?.roleProfile,
    baselineResultId: baseline?.id,
    currentResultId: current?.id,
    baselineStatus: baseline?.status,
    currentStatus: current?.status,
    baselineError: baseline?.error,
    currentError: current?.error,
    classification
  };
}

function classify(baseline?: ResultStatus, current?: ResultStatus): RegressionClassification {
  if (baseline === undefined && current !== undefined) {
    return isFailure(current) ? "new-failure" : "added-test";
  }
  if (baseline !== undefined && current === undefined) {
    return "missing-test";
  }
  if (baseline === undefined || current === undefined) {
    return "status-changed";
  }
  if (baseline === current) {
    return isFailure(current) ? "unchanged-failure" : "unchanged";
  }
  if (isFailure(baseline) && !isFailure(current)) {
    return "resolved-failure";
  }
  if (!isFailure(baseline) && isFailure(current)) {
    return "new-failure";
  }
  return "status-changed";
}

function findingComparisonEntry(
  fingerprint: string,
  baseline?: RunReportData["findings"][number],
  current?: RunReportData["findings"][number]
): RegressionFindingComparisonEntry {
  const representative = current ?? baseline;
  return {
    fingerprint,
    category: representative?.category ?? "",
    title: representative?.title ?? fingerprint,
    baselineFindingId: baseline?.id,
    currentFindingId: current?.id,
    baselineSeverity: baseline?.severity,
    currentSeverity: current?.severity,
    baselineTarget: baseline?.url ?? baseline?.endpoint,
    currentTarget: current?.url ?? current?.endpoint,
    classification: classifyFinding(baseline, current)
  };
}

function classifyFinding(
  baseline?: RunReportData["findings"][number],
  current?: RunReportData["findings"][number]
): RegressionFindingClassification {
  if (baseline && current) {
    return baseline.severity === current.severity && baseline.title === current.title ? "unchanged-finding" : "finding-changed";
  }
  return current ? "new-finding" : "resolved-finding";
}

function summarize(
  entries: RegressionComparisonEntry[],
  findingEntries: RegressionFindingComparisonEntry[],
  baselineTotal: number,
  currentTotal: number
): RegressionComparisonSummary {
  const summary: RegressionComparisonSummary = {
    passed: false,
    baselineTotal,
    currentTotal,
    comparedTotal: entries.length,
    unchanged: count(entries, "unchanged"),
    unchangedFailures: count(entries, "unchanged-failure"),
    newFailures: count(entries, "new-failure"),
    resolvedFailures: count(entries, "resolved-failure"),
    statusChanged: count(entries, "status-changed"),
    addedTests: count(entries, "added-test"),
    missingTests: count(entries, "missing-test"),
    unchangedFindings: countFindings(findingEntries, "unchanged-finding"),
    newFindings: countFindings(findingEntries, "new-finding"),
    resolvedFindings: countFindings(findingEntries, "resolved-finding"),
    changedFindings: countFindings(findingEntries, "finding-changed"),
    regressions: 0,
    improvements: 0
  };

  summary.regressions = summary.newFailures + summary.statusChanged + summary.missingTests + summary.newFindings + summary.changedFindings;
  summary.improvements = summary.resolvedFailures + summary.resolvedFindings;
  summary.passed = summary.regressions === 0;
  return summary;
}

function count(entries: RegressionComparisonEntry[], classification: RegressionClassification): number {
  return entries.filter((entry) => entry.classification === classification).length;
}

function countFindings(entries: RegressionFindingComparisonEntry[], classification: RegressionFindingClassification): number {
  return entries.filter((entry) => entry.classification === classification).length;
}

function isFailure(status: ResultStatus): boolean {
  return status === "FAIL" || status === "ERROR" || status === "BLOCKED";
}

function comparisonId(baselineId: string, currentRunId: string): string {
  return `comparison_${hash([baselineId, currentRunId].join("|")).slice(0, 16)}`;
}

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
