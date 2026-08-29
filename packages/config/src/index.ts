import { Ajv, type ErrorObject } from "ajv";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AuthProfileConfig, QAgentConfig, SecurityCheckKey, TargetEnvironment, TestLayer } from "#contracts";
import { DEFAULT_TEST_LAYERS, qaConfigSchema } from "./schema.js";

export { qaConfigSchema } from "./schema.js";

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
  urlOverride?: string;
  sourcePath?: string;
  profile?: string;
  layers?: TestLayer[];
  allowSourceCommands?: boolean;
}

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export interface ResolvedAuthProfile {
  name: string;
  loginUrl: string;
  credentials: {
    username: string;
    password: string;
  };
  selectors: AuthProfileConfig["selectors"];
  success: AuthProfileConfig["success"];
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateConfigSchema = ajv.compile(qaConfigSchema);
const DEFAULT_SECURITY_FAIL_ON: SecurityCheckKey[] = [
  "content-security-policy",
  "frame-protection",
  "x-content-type-options",
  "strict-transport-security",
  "cookie-http-only",
  "cookie-secure",
  "cookie-same-site"
];
const DEFAULT_SECURITY_CHECKS: Partial<Record<SecurityCheckKey, boolean>> = {
  "content-security-policy": true,
  "frame-protection": true,
  "x-content-type-options": true,
  "referrer-policy": true,
  "strict-transport-security": true,
  "cookie-http-only": true,
  "cookie-secure": true,
  "cookie-same-site": true
};

export function loadQAgentConfig(options: LoadConfigOptions = {}): QAgentConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolveConfigPath(cwd, options.configPath, options.sourcePath);
  let config: QAgentConfig;

  if (configPath && existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    config = parseQAgentConfig(raw, configPath);
  } else if (options.configPath) {
    throw new ConfigValidationError(`Config file not found: ${configPath}`);
  } else if (options.urlOverride || options.sourcePath) {
    config = createConfigFromOverrides({ cwd, urlOverride: options.urlOverride, sourcePath: options.sourcePath });
  } else {
    throw new ConfigValidationError("qa.config.yaml not found and no --url or source folder was provided.");
  }

  config = applyRunOverrides(config, options);
  validateProfileSelection(config, options.profile);
  return config;
}

export function parseQAgentConfig(raw: string, source = "qa.config.yaml"): QAgentConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new ConfigValidationError(`Invalid YAML in ${source}.`, [error instanceof Error ? error.message : String(error)]);
  }

  assertConfigShape(parsed, source);
  const normalized = normalizeConfig(parsed);
  const valid = validateConfigSchema(normalized);
  if (!valid) {
    throw new ConfigValidationError(`Invalid QAgent config in ${source}.`, formatAjvErrors());
  }

  return normalized;
}

export function createConfigFromOverrides(options: {
  cwd: string;
  urlOverride?: string;
  sourcePath?: string;
}): QAgentConfig {
  const projectName = basename(resolve(options.sourcePath ?? options.cwd)) || "qagent-project";
  const url = options.urlOverride;
  const host = url ? safeHostFromUrl(url) : undefined;
  const environment = deriveEnvironment(url);

  return normalizeConfig({
    project: { name: projectName },
    target: {
      environment,
      url,
      allowed_hosts: host ? [host] : []
    },
    source: options.sourcePath
      ? {
          adapter: "auto",
          fallback_to_cloud: Boolean(url)
        }
      : undefined
  });
}

export function starterConfigYaml(projectName = "example-web-app"): string {
  return `project:
  name: ${projectName}

target:
  environment: staging
  url: https://staging.example.com
  allowed_hosts:
    - staging.example.com

source:
  adapter: auto
  fallback_to_cloud: true

safety:
  destructive: false
  active_security_scan: false
  load_test: false
  max_concurrency: 3
  allow_source_commands: false

auth:
  profiles:
    admin:
      loginUrl: /login
      credentials:
        username: \${ADMIN_EMAIL}
        password: \${ADMIN_PASSWORD}
      selectors:
        username: '[name="email"]'
        password: '[name="password"]'
        submit: 'button[type="submit"]'
      success:
        urlContains: /dashboard

api:
  assertions: []
  authorization: []

accessibility:
  enabled: true
  engine: axe
  failOn: [critical, serious]
  maxViolations:
    critical: 0
    serious: 0
  exclude:
    - /logout
  maxPages: 25
  profiles: []

performance:
  enabled: true
  engine: browser-timing
  maxPages: 10
  waitUntil: load
  timeout_seconds: 15
  thresholds:
    maxFirstByteMs: 1000
    maxDomContentLoadedMs: 3000
    maxLoadEventMs: 5000
    maxTransferSizeBytes: 3145728
    maxResourceCount: 100

security:
  enabled: true
  engine: passive-http
  failOn:
    - content-security-policy
    - frame-protection
    - x-content-type-options
    - strict-transport-security
    - cookie-http-only
    - cookie-secure
    - cookie-same-site
  exclude:
    - /logout
  maxPages: 10
  timeout_seconds: 10
  checks:
    content-security-policy: true
    frame-protection: true
    x-content-type-options: true
    referrer-policy: true
    strict-transport-security: true
    cookie-http-only: true
    cookie-secure: true
    cookie-same-site: true

load:
  enabled: true
  engine: http-smoke
  maxPages: 3
  timeout_seconds: 10
  requestsPerTarget: 3
  concurrency: 1
  thresholds:
    maxErrorRate: 0
    maxAverageMs: 1000
    maxP95Ms: 2000

discovery:
  max_pages: 100
  max_depth: 2
  same_origin_only: true
  exclude:
    - /logout

tests:
  layers: [browser, api, authorization]
  retries: 1

permissions: {}

report:
  formats: [html, json, junit, xlsx]
  evidence_on: failure
  redact_headers: [authorization, cookie, set-cookie]
`;
}

function resolveConfigPath(cwd: string, configPath?: string, sourcePath?: string): string | undefined {
  if (configPath) {
    return resolve(cwd, configPath);
  }

  const defaultPath = resolve(cwd, "qa.config.yaml");
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  if (sourcePath) {
    const sourceConfigPath = resolve(cwd, sourcePath, "qa.config.yaml");
    if (existsSync(sourceConfigPath)) {
      return sourceConfigPath;
    }
  }

  return undefined;
}

function normalizeConfig(input: unknown): QAgentConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigValidationError("QAgent config must be a YAML object.");
  }

  const value = input as Partial<QAgentConfig>;
  const target = (value.target ?? {}) as Partial<QAgentConfig["target"]>;
  const report = (value.report ?? {}) as Partial<QAgentConfig["report"]>;
  const discovery = (value.discovery ?? {}) as Partial<QAgentConfig["discovery"]>;
  const tests = (value.tests ?? {}) as Partial<QAgentConfig["tests"]>;
  const safety = (value.safety ?? {}) as Partial<QAgentConfig["safety"]>;
  const auth = (value.auth ?? {}) as Partial<QAgentConfig["auth"]>;
  const api = (value.api ?? {}) as Partial<QAgentConfig["api"]>;
  const accessibility = (value.accessibility ?? {}) as Partial<QAgentConfig["accessibility"]>;
  const performance = (value.performance ?? {}) as Partial<QAgentConfig["performance"]>;
  const security = (value.security ?? {}) as Partial<QAgentConfig["security"]>;
  const load = (value.load ?? {}) as Partial<QAgentConfig["load"]>;

  return {
    project: value.project as QAgentConfig["project"],
    target: {
      ...target,
      environment: target.environment ?? deriveEnvironment(target.url),
      allowed_hosts: target.allowed_hosts ?? inferAllowedHosts(target.url)
    },
    source: value.source ? normalizeSourceConfig(value.source as Partial<NonNullable<QAgentConfig["source"]>>) : undefined,
    safety: {
      destructive: false,
      active_security_scan: false,
      load_test: false,
      max_concurrency: 3,
      allow_source_commands: false,
      ...safety
    },
    auth: {
      profiles: auth.profiles ?? {}
    },
    api: {
      assertions: [],
      authorization: [],
      ...api
    },
    accessibility: {
      enabled: true,
      engine: "axe",
      failOn: ["critical", "serious"],
      maxViolations: {
        critical: 0,
        serious: 0
      },
      exclude: [],
      maxPages: 25,
      profiles: [],
      timeout_seconds: 15,
      maxNodesPerRule: 5,
      ...accessibility
    },
    performance: {
      enabled: true,
      engine: "browser-timing",
      exclude: [],
      maxPages: 10,
      timeout_seconds: 15,
      waitUntil: "load",
      ...performance,
      thresholds: {
        maxFirstByteMs: 1000,
        maxDomContentLoadedMs: 3000,
        maxLoadEventMs: 5000,
        maxTransferSizeBytes: 3 * 1024 * 1024,
        maxResourceCount: 100,
        ...(performance.thresholds ?? {})
      }
    },
    security: {
      enabled: true,
      engine: "passive-http",
      failOn: DEFAULT_SECURITY_FAIL_ON,
      exclude: [],
      maxPages: 10,
      timeout_seconds: 10,
      ...security,
      checks: {
        ...DEFAULT_SECURITY_CHECKS,
        ...(security.checks ?? {})
      }
    },
    load: {
      enabled: true,
      engine: "http-smoke",
      exclude: [],
      maxPages: 3,
      timeout_seconds: 10,
      requestsPerTarget: 3,
      concurrency: 1,
      ...load,
      thresholds: {
        maxErrorRate: 0,
        maxAverageMs: 1000,
        maxP95Ms: 2000,
        ...(load.thresholds ?? {})
      }
    },
    discovery: {
      max_pages: 100,
      max_depth: 2,
      same_origin_only: true,
      exclude: [],
      ...discovery
    },
    tests: {
      layers: DEFAULT_TEST_LAYERS,
      retries: 0,
      ...tests
    },
    permissions: value.permissions ?? {},
    report: {
      formats: ["html", "json", "junit", "xlsx"],
      evidence_on: "failure",
      redact_headers: ["authorization", "cookie", "set-cookie"],
      ...report
    }
  };
}

function assertConfigShape(input: unknown, source: string): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigValidationError("QAgent config must be a YAML object.");
  }

  const valid = validateConfigSchema(input);
  if (!valid) {
    throw new ConfigValidationError(`Invalid QAgent config in ${source}.`, formatAjvErrors());
  }
}

function applyRunOverrides(config: QAgentConfig, options: LoadConfigOptions): QAgentConfig {
  const next: QAgentConfig = structuredClone(config);

  if (options.urlOverride) {
    const host = safeHostFromUrl(options.urlOverride);
    next.target.url = options.urlOverride;
    next.target.allowed_hosts = host ? [host] : [];
    next.target.environment = next.target.environment ?? deriveEnvironment(options.urlOverride);
  }

  if (options.sourcePath) {
    next.source = {
      adapter: "auto",
      fallback_to_cloud: Boolean(next.target.url),
      ...next.source
    };
  }

  if (options.layers?.length) {
    next.tests.layers = options.layers;
  }

  if (options.allowSourceCommands) {
    next.safety.allow_source_commands = true;
  }

  return next;
}

function normalizeSourceConfig(source: Partial<NonNullable<QAgentConfig["source"]>>): QAgentConfig["source"] {
  const commands = source.commands as Record<string, unknown> | undefined;
  return {
    ...source,
    commands: commands
      ? Object.fromEntries(
          Object.entries(commands).map(([name, command]) => [
            name,
            typeof command === "string"
              ? {
                  executable: command
                }
              : command
          ])
        )
      : undefined
  };
}

function validateProfileSelection(config: QAgentConfig, profile?: string): void {
  if (!profile) {
    return;
  }

  if (!config.auth.profiles[profile]) {
    throw new ConfigValidationError(`Profile '${profile}' is not defined in auth.profiles.`);
  }
}

function formatAjvErrors(): string[] {
  return (validateConfigSchema.errors ?? []).map((error: ErrorObject) => {
    const path = error.instancePath || "/";
    if (error.keyword === "additionalProperties" && error.params && "additionalProperty" in error.params) {
      return `${path}: unknown field '${String(error.params.additionalProperty)}'`;
    }
    return `${path}: ${error.message ?? "invalid value"}`;
  });
}

function inferAllowedHosts(url?: string): string[] {
  const host = safeHostFromUrl(url);
  return host ? [host] : [];
}

function safeHostFromUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function deriveEnvironment(url?: string): TargetEnvironment {
  const host = safeHostFromUrl(url);
  if (!host) {
    return "local";
  }

  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "local";
  }

  return host.includes("staging") ? "staging" : "development";
}

export function configBaseDir(configPath?: string, cwd = process.cwd()): string {
  return configPath ? dirname(resolve(cwd, configPath)) : cwd;
}

export function resolveAuthProfile(config: QAgentConfig, profileName: string, env: NodeJS.ProcessEnv = process.env): ResolvedAuthProfile {
  const profile = config.auth.profiles[profileName];
  if (!profile) {
    throw new ConfigValidationError(`Profile '${profileName}' is not defined in auth.profiles.`);
  }

  const issues: string[] = [];
  requireEnvExpression(profile.credentials.username, `auth.profiles.${profileName}.credentials.username`, issues);
  requireEnvExpression(profile.credentials.password, `auth.profiles.${profileName}.credentials.password`, issues);
  const username = resolveEnvExpression(profile.credentials.username, `auth.profiles.${profileName}.credentials.username`, env, issues);
  const password = resolveEnvExpression(profile.credentials.password, `auth.profiles.${profileName}.credentials.password`, env, issues);

  if (issues.length > 0) {
    throw new ConfigValidationError(`Unable to resolve credentials for auth profile '${profileName}'.`, issues);
  }

  return {
    name: profileName,
    loginUrl: profile.loginUrl,
    credentials: {
      username,
      password
    },
    selectors: profile.selectors,
    success: profile.success
  };
}

export function authProfileUsernameRef(config: QAgentConfig, profileName: string): string {
  return config.auth.profiles[profileName]?.credentials.username ?? "";
}

function requireEnvExpression(value: string, fieldPath: string, issues: string[]): void {
  if (!/^\$\{[A-Z0-9_]+\}$/i.test(value.trim())) {
    issues.push(`${fieldPath} must reference exactly one environment variable like \${ADMIN_EMAIL}`);
  }
}

function resolveEnvExpression(value: string, fieldPath: string, env: NodeJS.ProcessEnv, issues: string[]): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, envName: string) => {
    const resolved = env[envName];
    if (resolved === undefined || resolved === "") {
      issues.push(`${fieldPath} references missing environment variable ${envName}`);
      return match;
    }
    return resolved;
  });
}
