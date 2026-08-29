import type { ApiEndpoint, EvidenceRef, Finding, DiscoveredPage } from "#contracts";

export interface EndpointAccumulator {
  id: string;
  runId: string;
  method: string;
  normalizedPath: string;
  statusCodes: Set<number>;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PageObservation {
  consoleErrors: string[];
  networkErrors: string[];
  responseStatusByUrl: Map<string, number>;
  endpoints: Map<string, EndpointAccumulator>;
  findings: Finding[];
}

export interface DiscoveryOptions {
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
  headless?: boolean;
}

export interface QueuedPage {
  url: string;
  normalizedUrl: string;
  depth: number;
  sourceUrl?: string;
}

export interface PageInspectionResult {
  page: DiscoveredPage;
  links: string[];
  evidence: EvidenceRef[];
}

export interface CrawlResult {
  pages: DiscoveredPage[];
  apiEndpoints: ApiEndpoint[];
  findings: Finding[];
  evidence: EvidenceRef[];
}
