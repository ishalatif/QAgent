import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { authProfileUsernameRef, resolveAuthProfile } from "#config";
import type { AuthProfileReport, QAgentConfig } from "#contracts";
import { safeUrlForReport } from "./url-utils.js";

export interface AuthValidation {
  ok: boolean;
  actual: {
    url: string;
    urlContains?: boolean;
    selectorVisible?: boolean;
  };
}

export interface AuthAttemptResult {
  status: "PASS" | "FAIL";
  expected: unknown;
  actual: unknown;
  reason?: string;
  sessionArtifact?: string;
}

export interface LoginAttemptOptions {
  expectSuccess?: boolean;
  saveSession?: boolean;
  usernameOverride?: string;
  passwordOverride?: string;
  timeoutMs?: number;
}

export interface PlaywrightAuthActions {
  login(profileName: string, options?: LoginAttemptOptions): Promise<AuthAttemptResult>;
  validateSuccess(profileName: string, timeoutMs?: number): Promise<AuthValidation>;
  reportProfile(profileName: string): AuthProfileReport;
  sessionArtifact(profileName: string): string;
  sessionStatePath(profileName: string): string;
}

export class PlaywrightAuthActionsImpl implements PlaywrightAuthActions {
  constructor(
    private readonly input: {
      config: QAgentConfig;
      baseUrl: string;
      sessionRoot: string;
      context: BrowserContext;
      page: Page;
    }
  ) {}

  async login(profileName: string, options: LoginAttemptOptions = {}): Promise<AuthAttemptResult> {
    const profile = resolveAuthProfile(this.input.config, profileName);
    const timeoutMs = options.timeoutMs ?? 10_000;
    const expectSuccess = options.expectSuccess ?? true;
    const loginUrl = new URL(profile.loginUrl, this.input.baseUrl).toString();

    await this.input.page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await this.input.page.fill(profile.selectors.username, options.usernameOverride ?? profile.credentials.username, { timeout: timeoutMs });
    await this.input.page.fill(profile.selectors.password, options.passwordOverride ?? profile.credentials.password, { timeout: timeoutMs });
    await this.input.page.click(profile.selectors.submit, { timeout: timeoutMs });
    await this.input.page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 5_000) }).catch(() => undefined);
    await this.input.page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 1_000) }).catch(() => undefined);

    const validation = await this.validateSuccess(profileName, timeoutMs);
    const passed = expectSuccess ? validation.ok : !validation.ok;
    const sessionArtifact = this.sessionArtifact(profileName);

    if (passed && expectSuccess && options.saveSession !== false) {
      const statePath = this.sessionStatePath(profileName);
      mkdirSync(dirname(statePath), { recursive: true });
      await this.input.context.storageState({ path: statePath });
    }

    return {
      status: passed ? "PASS" : "FAIL",
      expected: {
        profile: profileName,
        authenticated: expectSuccess,
        success: profile.success
      },
      actual: {
        profile: profileName,
        resultKey: `auth.profile.${profileName}`,
        authenticated: validation.ok,
        url: validation.actual.url,
        success: validation.actual,
        sessionArtifact: passed && expectSuccess ? sessionArtifact : undefined
      },
      reason: passed ? undefined : expectSuccess ? "Authentication success criteria were not met." : "Invalid credentials unexpectedly authenticated.",
      sessionArtifact
    };
  }

  async validateSuccess(profileName: string, timeoutMs = 5_000): Promise<AuthValidation> {
    const profile = resolveAuthProfile(this.input.config, profileName);
    const url = safeUrlForReport(this.input.page.url());
    const checks: boolean[] = [];
    const actual: AuthValidation["actual"] = { url };

    if (profile.success.urlContains) {
      actual.urlContains = this.input.page.url().includes(profile.success.urlContains);
      checks.push(actual.urlContains);
    }

    if (profile.success.selector) {
      actual.selectorVisible = await this.input.page
        .locator(profile.success.selector)
        .first()
        .isVisible({ timeout: Math.min(timeoutMs, 1_000) })
        .catch(() => false);
      checks.push(actual.selectorVisible);
    }

    return {
      ok: checks.length > 0 && checks.every(Boolean),
      actual
    };
  }

  reportProfile(profileName: string): AuthProfileReport {
    return authProfileReport(this.input.config, this.input.baseUrl, profileName);
  }

  sessionArtifact(profileName: string): string {
    return [".qagent", "sessions", originKey(this.input.baseUrl), `${safeFilePart(profileName)}.storageState.json`].join("/");
  }

  sessionStatePath(profileName: string): string {
    return sessionStatePath(this.input.sessionRoot, this.input.baseUrl, profileName);
  }
}

export function sessionStatePath(sessionRoot: string, baseUrl: string, profileName: string): string {
  return join(sessionRoot, originKey(baseUrl), `${safeFilePart(profileName)}.storageState.json`);
}

export function authProfileReport(config: QAgentConfig, baseUrl: string, profileName: string): AuthProfileReport {
  const profile = config.auth.profiles[profileName];
  return {
    name: profileName,
    loginUrl: profile.loginUrl,
    usernameRef: authProfileUsernameRef(config, profileName),
    success: profile.success,
    sessionArtifact: [".qagent", "sessions", originKey(baseUrl), `${safeFilePart(profileName)}.storageState.json`].join("/")
  };
}

export function firstAuthProfileName(config: QAgentConfig): string {
  const [profileName] = Object.keys(config.auth.profiles).sort();
  if (!profileName) {
    throw new Error("No auth profiles are defined.");
  }
  return profileName;
}

function originKey(baseUrl: string): string {
  const origin = new URL(baseUrl).origin;
  return createHash("sha256").update(origin).digest("hex").slice(0, 12);
}

function safeFilePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "profile";
}
