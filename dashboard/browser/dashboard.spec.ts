import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { startDashboard } from '../server/http.js';
import { startAgent, type Source } from '../server/agent.js';
import type { LogEvent } from '../shared/protocol.js';

const clientDir = fileURLToPath(new URL('../dist/client', import.meta.url));
let directory: string;
let bridge: Awaited<ReturnType<typeof startDashboard>>;
const agents: Awaited<ReturnType<typeof startAgent>>[] = [];

test.beforeEach(async () => {
  directory = await mkdtemp('/tmp/sd-ui-');
  bridge = await startDashboard({ directory, clientDir });
});
test.afterEach(async () => {
  await Promise.all([bridge.close(), ...agents.splice(0).map((agent) => agent.close())]);
  await rm(directory, { recursive: true, force: true });
});

test('requires a launch link, shows honest empty state and removes token from URL', async ({ page }) => {
  await page.goto(bridge.origin);
  await expect(page.getByRole('heading', { name: 'Open your private dashboard link' })).toBeVisible();
  await page.goto(bridge.url);
  await expect(page.getByRole('heading', { name: 'Your gateways will appear here.' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your gateways will appear here.' })).toBeVisible();
});

test('renders sessions, filters real telemetry, exports events and stays usable on mobile', async ({ page }, info) => {
  const startedAt = new Date(Date.now() - 240_000).toISOString();
  let listener: ((event: LogEvent) => void) | undefined;
  const source: Source = {
    inspect: () => ({
      services: ['billing', 'crm', 'inventory'].map((name, index) => ({
        name, transport: 'sse', status: index === 2 ? 'offline' : 'ready',
        toolCount: index === 2 ? 0 : 6, activeRequests: 0, connectedAt: index === 2 ? null : startedAt,
        lastActivityAt: startedAt,
      })),
      requests: [], requestsTruncated: 0, completedCalls: 24, failedCalls: 1,
    }),
    subscribe: (fn) => { listener = fn; return () => { listener = undefined; }; },
  };
  const agent = await startAgent(source, directory);
  agents.push(agent);
  listener?.({ time: new Date().toISOString(), level: 'info', service: 'billing', message: 'Downstream connected' });
  listener?.({ time: new Date().toISOString(), level: 'warn', service: 'inventory', message: 'Downstream unavailable; restart gateway to reconnect' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(bridge.url);
  await expect(page.getByRole('heading', { name: agent.id.slice(0, 8) })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'billing', exact: false }).first()).toBeVisible();
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await page.getByLabel('Filter services').fill('crm');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Filter services').clear();
  await page.screenshot({ path: info.outputPath('overview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Activity', exact: false }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSONL', exact: false }).click();
  expect((await download).suggestedFilename()).toMatch(/^synapse-events-.*\.jsonl$/);
  await page.getByLabel('Filter log level').selectOption('warn');
  await expect(page.getByText('Downstream connected', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Overview', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Everything connected.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('overview-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
  await agent.close();
  await expect(page.getByRole('heading', { name: 'Your gateways will appear here.' })).toBeVisible({ timeout: 7000 });
});

test('shows stale data notice when bridge stops instead of pretending to be live', async ({ page }) => {
  await page.goto(bridge.url);
  await expect(page.getByRole('heading', { name: 'Your gateways will appear here.' })).toBeVisible();
  await bridge.close();
  await expect(page.getByRole('alert')).toContainText('Connection lost', { timeout: 10_000 });
  await expect(page.getByText('Snapshot stale')).toBeVisible();
});
