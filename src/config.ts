import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const serviceSchema = z.object({
  // No double/trailing separators: splitting at the first "__" is unambiguous.
  name: z.string().max(32).regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/),
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
  timeout: z.number().int().min(100).max(300_000).default(10_000),
}).strict();

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
  SERVICE_AUTH_TOKEN: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/),
  TENANT_ID: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  MCP_CONFIG_PATH: z.string().min(1).default('config.json'),
  MCP_DASHBOARD_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

export type ServiceConfig = Readonly<z.infer<typeof serviceSchema>>;
export type GatewayConfig = Readonly<{
  serviceAuthToken: string;
  tenantId: string;
  services: readonly ServiceConfig[];
  dashboardEnabled?: boolean;
}>;

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<GatewayConfig> {
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
  return Object.freeze({
    serviceAuthToken: parsedEnv.data.SERVICE_AUTH_TOKEN,
    tenantId: parsedEnv.data.TENANT_ID,
    dashboardEnabled: parsedEnv.data.MCP_DASHBOARD_ENABLED,
    services: Object.freeze(parsedFile.data.services.map((service) => Object.freeze(service))),
  });
}
