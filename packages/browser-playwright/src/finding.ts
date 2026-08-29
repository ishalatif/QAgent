import type { EvidenceRef, Finding } from "#contracts";
import { sha256, stableRecordId } from "./ids.js";

export function createFinding(input: Omit<Finding, "id" | "fingerprint" | "evidenceRefs" | "redactionApplied"> & { runId: string; evidenceRefs?: EvidenceRef[] }): Finding {
  const fingerprint = sha256([input.category, input.title, input.description, input.url ?? "", input.method ?? "", input.endpoint ?? ""].join("|")).slice(0, 16);

  return {
    id: stableRecordId(input.runId, "finding", fingerprint),
    fingerprint,
    category: input.category,
    severity: input.severity,
    title: input.title,
    description: input.description,
    url: input.url,
    method: input.method,
    endpoint: input.endpoint,
    roleProfile: input.roleProfile,
    remediationHint: input.remediationHint,
    evidenceRefs: input.evidenceRefs ?? [],
    redactionApplied: true
  };
}

export function attachEvidenceToFindings(findings: Finding[], evidence: EvidenceRef[]): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    evidenceRefs: mergeEvidence(finding.evidenceRefs, evidence)
  }));
}

function mergeEvidence(current: EvidenceRef[], next: EvidenceRef[]): EvidenceRef[] {
  const byId = new Map<string, EvidenceRef>();
  for (const item of [...current, ...next]) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}
