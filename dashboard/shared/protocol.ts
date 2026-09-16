import { z } from 'zod';

export const MAX_SNAPSHOT_BYTES = 512 * 1024;
export const MAX_EVENTS = 200;
export const MAX_SESSIONS = 32;

export const logEventSchema = z.object({
  time: z.string().datetime(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string().max(512),
  service: z.string().max(32).optional(),
}).strict();

export const inspectionSchema = z.object({
  services: z.array(z.object({
    name: z.string().max(32),
    transport: z.enum(['sse', 'streamable-http']),
    status: z.enum(['connecting', 'ready', 'offline']),
    toolCount: z.number().int().nonnegative(),
    activeRequests: z.number().int().nonnegative(),
    connectedAt: z.string().datetime().nullable(),
    lastActivityAt: z.string().datetime().nullable(),
  }).strict()).max(64),
  requests: z.array(z.object({
    id: z.string().uuid(),
    service: z.string().max(32),
    startedAt: z.string().datetime(),
  }).strict()).max(128),
  requestsTruncated: z.number().int().nonnegative(),
  completedCalls: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative(),
}).strict();

export const sessionSchema = inspectionSchema.extend({
  version: z.literal(1),
  id: z.string().uuid(),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  events: z.array(logEventSchema).max(MAX_EVENTS),
});

export const dashboardSchema = z.object({
  capturedAt: z.string().datetime(),
  sessions: z.array(sessionSchema).max(MAX_SESSIONS),
  unavailable: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();

export type LogEvent = z.infer<typeof logEventSchema>;
export type Inspection = z.infer<typeof inspectionSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type DashboardSnapshot = z.infer<typeof dashboardSchema>;
