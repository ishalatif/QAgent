import type { QAgentConfig } from "#contracts";
import { redactText } from "#core";

export function normalizePageUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.search = "";
  url.pathname = normalizePathname(url.pathname);
  return url.toString();
}

export function normalizeEndpointPath(rawUrl: string): string {
  const url = new URL(rawUrl);
  return normalizePathname(url.pathname);
}

export function resolveUrl(rawUrl: string, baseUrl: string): string {
  return new URL(rawUrl, baseUrl).toString();
}

export function isCrawlableUrl(rawUrl: string, baseUrl: string, config: QAgentConfig): boolean {
  let candidate: URL;
  let base: URL;
  try {
    candidate = new URL(rawUrl, baseUrl);
    base = new URL(baseUrl);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(candidate.protocol)) {
    return false;
  }

  if (config.discovery.same_origin_only && candidate.origin !== base.origin) {
    return false;
  }

  const allowedHosts = config.target.allowed_hosts ?? [];
  if (allowedHosts.length > 0 && !allowedHosts.includes(candidate.hostname)) {
    return false;
  }

  return !matchesExcludedPath(candidate.pathname, config.discovery.exclude);
}

export function safeUrlForReport(rawUrl: string): string {
  try {
    return normalizePageUrl(rawUrl);
  } catch {
    return redactText(rawUrl);
  }
}

export function matchesExcludedPath(pathname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern
      .split("*")
      .map((part) => escapeRegExp(part))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(pathname);
  });
}

function normalizePathname(pathname: string): string {
  if (!pathname) {
    return "/";
  }
  return pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
