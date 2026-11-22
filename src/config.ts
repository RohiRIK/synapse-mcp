import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

// No double/trailing separators: splitting at the first "__" is unambiguous.
const serviceName = z.string().max(32).regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/);
const serviceTimeout = z.number().int().min(100).max(300_000).default(10_000);

const sseServiceSchema = z.object({
  name: serviceName,
  transport: z.literal('sse').default('sse'),
  url: z.string().url().superRefine((value, ctx) => {
    let url: URL;
    try { url = new URL(value); } catch { return; } // z.string().url() reports malformed URLs.
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      ctx.addIssue({ code: 'custom', message: 'Use HTTPS (HTTP is allowed only on loopback)' });
    }
    if (url.username || url.password || url.hash) {
      ctx.addIssue({ code: 'custom', message: 'URL credentials and fragments are forbidden' });
    }
  }),
  timeout: serviceTimeout,
}).strict();

/** Variables a stdio service may never set: they carry the gateway's own identity. */
export const RESERVED_CHILD_ENV = ['SYNAPSE_TENANT_ID', 'SYNAPSE_SERVICE_NAME'] as const;

/**
 * A local MCP server the gateway starts as a child process and speaks to over its stdin/stdout.
 * The child gets a minimal inherited environment (PATH, HOME and the like), the `env` named
 * here, and SYNAPSE_TENANT_ID / SYNAPSE_SERVICE_NAME. It never gets SERVICE_AUTH_TOKEN.
 */
const stdioServiceSchema = z.object({
  name: serviceName,
  transport: z.literal('stdio'),
  command: z.string().min(1).max(1024),
  args: z.array(z.string().max(4096)).max(64).default([]),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), z.string().max(8192))
    .refine((env) => Object.keys(env).length <= 64, 'At most 64 variables')
    .refine((env) => !Object.keys(env).some((key) => (RESERVED_CHILD_ENV as readonly string[]).includes(key)),
      'SYNAPSE_TENANT_ID and SYNAPSE_SERVICE_NAME are set by the gateway')
    .default({}),
  cwd: z.string().min(1).max(4096).optional(),
  timeout: serviceTimeout,
}).strict();

const serviceSchema = z.union([stdioServiceSchema, sseServiceSchema]);

export const fileConfigSchema = z.object({
  services: z.array(serviceSchema).min(1).max(64),
}).strict().superRefine(({ services }, ctx) => {
  const names = new Set<string>();
  services.forEach((service, index) => {
    if (names.has(service.name)) {
      ctx.addIssue({ code: 'custom', path: ['services', index, 'name'], message: 'Duplicate service name' });
    }
    names.add(service.name);
  });
});

const envSchema = z.object({
  // Header-safe, nonempty bearer credential. Never print validation input values.
  // Required only when an SSE service is configured; stdio children never receive it.
  SERVICE_AUTH_TOKEN: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/).optional(),
  TENANT_ID: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  MCP_CONFIG_PATH: z.string().min(1).default('config.json'),
  MCP_DASHBOARD_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

export type ServiceConfig = Readonly<z.infer<typeof serviceSchema>>;
export type SseServiceConfig = Readonly<z.infer<typeof sseServiceSchema>>;
export type StdioServiceConfig = Readonly<z.infer<typeof stdioServiceSchema>>;
export type GatewayConfig = Readonly<{
  /** Empty when only stdio services are configured. */
  serviceAuthToken: string;
  tenantId: string;
  services: readonly ServiceConfig[];
  dashboardEnabled?: boolean;
}>;

export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<GatewayConfig> {
  const parsedEnv = envSchema.safeParse(env);
  if (!parsedEnv.success) {
    const fields = [...new Set(parsedEnv.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid or missing environment variables: ${fields.join(', ')}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(parsedEnv.data.MCP_CONFIG_PATH), 'utf8'));
  } catch {
    throw new Error('Cannot read or parse MCP_CONFIG_PATH (expected a JSON file)');
  }
  const parsedFile = fileConfigSchema.safeParse(raw);
  if (!parsedFile.success) {
    // Do not expose raw URLs, credential-bearing inputs, or Zod's full error object.
    const fields = parsedFile.error.issues.map((issue) => issue.path.join('.') || 'config');
    throw new Error(`Invalid config.json fields: ${fields.join(', ')}`);
  }
  const needsToken = parsedFile.data.services.some((service) => service.transport === 'sse');
  if (needsToken && parsedEnv.data.SERVICE_AUTH_TOKEN === undefined) {
    throw new Error('Invalid or missing environment variables: SERVICE_AUTH_TOKEN (required for SSE services)');
  }
  return Object.freeze({
    serviceAuthToken: parsedEnv.data.SERVICE_AUTH_TOKEN ?? '',
    tenantId: parsedEnv.data.TENANT_ID,
    dashboardEnabled: parsedEnv.data.MCP_DASHBOARD_ENABLED,
    services: Object.freeze(parsedFile.data.services.map((service) => Object.freeze(service))),
  });
}
