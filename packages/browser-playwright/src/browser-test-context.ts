import type { BrowserContext, Page } from "playwright";
import type { BrowserTestContext } from "#browser-tests";
import type { QAgentConfig } from "#contracts";
import type { PlaywrightAuthActions } from "./auth.js";

export interface PlaywrightBrowserTestContext extends BrowserTestContext {
  config: QAgentConfig;
  context: BrowserContext;
  page: Page;
  auth: PlaywrightAuthActions;
  defaultProfile: string;
}
