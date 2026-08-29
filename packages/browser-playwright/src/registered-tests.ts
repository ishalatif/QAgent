import { BrowserTestRegistry, type BrowserTestOutcome } from "#browser-tests";
import type { QAgentConfig } from "#contracts";
import type { PlaywrightBrowserTestContext } from "./browser-test-context.js";
import { safeUrlForReport } from "./url-utils.js";

export function createDefaultBrowserTestRegistry(profileName = "admin"): BrowserTestRegistry<PlaywrightBrowserTestContext> {
  const registry = new BrowserTestRegistry<PlaywrightBrowserTestContext>();

  registry.register({
    key: "auth.valid-login",
    title: "Auth profile can sign in with valid credentials",
    layer: "browser",
    tags: ["auth", "positive"],
    priority: "P0",
    profile: profileName,
    timeoutMs: 10_000,
    dependencies: [],
    run: async (ctx) => ctx.auth.login(profileName, { expectSuccess: true, saveSession: true, timeoutMs: 10_000 })
  });

  registry.register({
    key: "auth.invalid-login",
    title: "Invalid password is rejected",
    layer: "browser",
    tags: ["auth", "negative"],
    priority: "P0",
    profile: profileName,
    timeoutMs: 10_000,
    dependencies: [],
    run: async (ctx) =>
      ctx.auth.login(profileName, {
        expectSuccess: false,
        saveSession: false,
        passwordOverride: "__qagent_invalid_password__",
        timeoutMs: 10_000
      })
  });

  registry.register({
    key: "auth.protected-route",
    title: "Protected dashboard redirects without a session",
    layer: "browser",
    tags: ["auth", "session"],
    priority: "P0",
    timeoutMs: 10_000,
    dependencies: [],
    run: async (ctx) => {
      const profile = ctx.config.auth.profiles[ctx.defaultProfile];
      const protectedUrl = dashboardUrl(ctx.baseUrl, ctx.config, ctx.defaultProfile);
      await ctx.page.goto(protectedUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await ctx.page.waitForLoadState("networkidle", { timeout: 1_000 }).catch(() => undefined);
      const actualUrl = safeUrlForReport(ctx.page.url());
      const redirected = ctx.page.url().includes(profile.loginUrl);
      return {
        status: redirected ? "PASS" : "FAIL",
        expected: {
          route: protectedUrl,
          unauthenticatedRedirect: profile.loginUrl
        },
        actual: {
          url: actualUrl,
          redirectedToLogin: redirected
        },
        reason: redirected ? undefined : "Protected route was reachable without an authenticated session."
      } satisfies BrowserTestOutcome;
    }
  });

  registry.register({
    key: "auth.logout",
    title: "Logout invalidates the authenticated session",
    layer: "browser",
    tags: ["auth", "session"],
    priority: "P1",
    profile: profileName,
    timeoutMs: 10_000,
    dependencies: ["auth.valid-login"],
    run: async (ctx) => {
      const profile = ctx.config.auth.profiles[ctx.defaultProfile];
      await ctx.page.goto(new URL("/logout", ctx.baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 10_000 });
      await ctx.page.goto(dashboardUrl(ctx.baseUrl, ctx.config, ctx.defaultProfile), { waitUntil: "domcontentloaded", timeout: 10_000 });
      await ctx.page.waitForLoadState("networkidle", { timeout: 1_000 }).catch(() => undefined);
      const redirected = ctx.page.url().includes(profile.loginUrl);
      return {
        status: redirected ? "PASS" : "FAIL",
        expected: {
          logoutUrl: "/logout",
          dashboardAfterLogout: "redirects to login"
        },
        actual: {
          url: safeUrlForReport(ctx.page.url()),
          redirectedToLogin: redirected
        },
        reason: redirected ? undefined : "Dashboard remained reachable after logout."
      } satisfies BrowserTestOutcome;
    }
  });

  registry.register({
    key: "navigation.dashboard",
    title: "Authenticated dashboard is reachable",
    layer: "browser",
    tags: ["navigation", "auth"],
    priority: "P1",
    profile: profileName,
    timeoutMs: 10_000,
    dependencies: ["auth.valid-login"],
    run: async (ctx) => {
      await ctx.page.goto(dashboardUrl(ctx.baseUrl, ctx.config, ctx.defaultProfile), { waitUntil: "domcontentloaded", timeout: 10_000 });
      await ctx.page.waitForLoadState("networkidle", { timeout: 1_000 }).catch(() => undefined);
      const validation = await ctx.auth.validateSuccess(ctx.defaultProfile, 10_000);
      return {
        status: validation.ok ? "PASS" : "FAIL",
        expected: {
          route: dashboardUrl(ctx.baseUrl, ctx.config, ctx.defaultProfile),
          authenticated: true
        },
        actual: {
          url: validation.actual.url,
          title: await ctx.page.title().catch(() => ""),
          authenticated: validation.ok,
          success: validation.actual
        },
        reason: validation.ok ? undefined : "Authenticated dashboard success criteria were not met."
      } satisfies BrowserTestOutcome;
    }
  });

  return registry;
}

function dashboardUrl(baseUrl: string, config: QAgentConfig, profileName: string): string {
  const profile = config.auth.profiles[profileName];
  return new URL(profile.success.urlContains ?? "/dashboard", baseUrl).toString();
}
