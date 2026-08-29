import { isIP } from "node:net";
import type { QAgentConfig } from "#contracts";

export class SafetyPolicyError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Unsafe QAgent operation: ${issues.join("; ")}`);
    this.name = "SafetyPolicyError";
    this.issues = issues;
  }
}

export interface SafetyValidationInput {
  config: QAgentConfig;
  url?: string;
}

export function validateTargetSafety(input: SafetyValidationInput): void {
  const issues: string[] = [];
  const url = input.url ?? input.config.target.url;

  if (url) {
    validateWebUrl(url, input.config.target.allowed_hosts ?? [], input.config.target.environment, issues);
  }

  if (input.config.target.environment === "production") {
    if (input.config.safety.destructive) {
      issues.push("destructive tests are disabled for production targets");
    }
    if (input.config.safety.active_security_scan) {
      issues.push("active security scan is disabled for production targets");
    }
    if (input.config.safety.load_test) {
      issues.push("load testing is disabled for production targets");
    }
  }

  if (input.config.safety.max_concurrency > 10 && input.config.target.environment === "production") {
    issues.push("production max_concurrency must be 10 or lower");
  }

  if (issues.length) {
    throw new SafetyPolicyError(issues);
  }
}

function validateWebUrl(url: string, allowedHosts: string[], environment: QAgentConfig["target"]["environment"], issues: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    issues.push(`target URL is invalid: ${url}`);
    return;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    issues.push(`target URL scheme must be http or https: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    issues.push("target URL must not contain username or password credentials");
  }

  const host = normalizeHost(parsed.hostname);
  if (environment === "production") {
    if (parsed.protocol !== "https:") {
      issues.push("production target URL must use https");
    }
    if (isPrivateOrLocalHost(host)) {
      issues.push(`production target host '${parsed.hostname}' must not be local, reserved, or private network`);
    }
  }

  const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts, issues);
  if (normalizedAllowedHosts.length > 0 && !normalizedAllowedHosts.includes(host)) {
    issues.push(`target host '${parsed.hostname}' is outside allowed_hosts`);
  }
}

function normalizeAllowedHosts(allowedHosts: string[], issues: string[]): string[] {
  const hosts: string[] = [];
  for (const allowedHost of allowedHosts) {
    const trimmed = allowedHost.trim();
    const normalized = normalizeHost(trimmed);
    if (!trimmed) {
      issues.push("allowed_hosts entries must not be empty");
      continue;
    }
    if (trimmed.includes("://") || /[/?#@\s]/.test(trimmed) || trimmed.includes("*")) {
      issues.push(`allowed_hosts entry '${allowedHost}' must be a bare hostname or IP literal`);
      continue;
    }
    if (normalized.includes(":") && isIP(normalized) !== 6) {
      issues.push(`allowed_hosts entry '${allowedHost}' must not include a port`);
      continue;
    }
    if (isIP(normalized) === 0 && !/^[a-z0-9.-]+$/i.test(normalized)) {
      issues.push(`allowed_hosts entry '${allowedHost}' contains unsupported characters`);
      continue;
    }
    hosts.push(normalized);
  }
  return [...new Set(hosts)];
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

function isPrivateOrLocalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test")) {
    return true;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return isPrivateOrReservedIpv4(host);
  }
  if (ipVersion === 6) {
    return isPrivateOrReservedIpv6(host);
  }
  return false;
}

function isPrivateOrReservedIpv4(host: string): boolean {
  const [first = 0, second = 0] = host.split(".").map((part) => Number(part));
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateOrReservedIpv6(host: string): boolean {
  if (host === "::" || host === "::1") {
    return true;
  }
  if (host.startsWith("::ffff:")) {
    const mappedIpv4 = host.slice("::ffff:".length);
    return isIP(mappedIpv4) === 4 ? isPrivateOrReservedIpv4(mappedIpv4) : true;
  }

  const firstHextet = Number.parseInt(host.split(":")[0] || "0", 16);
  return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
}
