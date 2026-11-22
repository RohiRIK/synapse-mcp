import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileConfigSchema, loadConfig } from '../src/config.js';
import { childEnvironment, DownstreamManager } from '../src/downstream.js';
import {
  answerTokenRequest, assertGraphScopes, createMemorySession, type MsalAccountLike, type MsalLike, type MsalResultLike,
} from '../src/signin.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const HOUR = 3_600_000;

type FakeMsal = MsalLike & { interactive: number; accounts: MsalAccountLike[] };
function fakeMsal(opts: { tenantId?: string; clock: () => number; delayMs?: number; label?: string }): FakeMsal {
  const msal: FakeMsal = {
    interactive: 0,
    accounts: [],
    async acquireTokenSilent({ scopes }): Promise<MsalResultLike> {
      return { accessToken: `${opts.label ?? ''}silent:${scopes.join(' ')}`, expiresOn: new Date(opts.clock() + HOUR), account: msal.accounts[0] ?? null };
    },
    async acquireTokenInteractive({ scopes }): Promise<MsalResultLike> {
      msal.interactive++;
      if (opts.delayMs) await new Promise((done) => setTimeout(done, opts.delayMs));
      const account = { tenantId: opts.tenantId ?? TENANT, homeAccountId: 'a', username: 'u@example.test' };
      msal.accounts = [account];
      return { accessToken: `${opts.label ?? ''}interactive:${scopes.join(' ')}`, expiresOn: new Date(opts.clock() + HOUR), account };
    },
    getTokenCache() {
      return {
        getAllAccounts: async () => [...msal.accounts],
        removeAccount: async (account: never) => { msal.accounts = msal.accounts.filter((a) => a !== account); },
      };
    },
  };
  return msal;
}
const session = (msal: MsalLike, clock: () => number, maxSessionAgeMs = 8 * HOUR) => createMemorySession({
  msal, tenantId: TENANT, maxSessionAgeMs, openBrowser: async () => {}, selectAccountPrompt: 'select_account', now: clock,
});

test('sign-in: only Graph delegated scopes are lent', () => {
  assert.deepEqual(assertGraphScopes(['User.Read.All', 'https://graph.microsoft.com/Group.Read.All', 'offline_access']).length, 3);
  for (const scope of ['https://graph.microsoft.com/.default', 'https://outlook.office365.com/.default', 'https://management.azure.com/user_impersonation']) {
    assert.throws(() => assertGraphScopes([scope]), /only lends/);
  }
  assert.throws(() => assertGraphScopes([]), /no scopes/);
  assert.throws(() => assertGraphScopes('User.Read'), /no scopes/);
});

test('sign-in: once, silently after, one browser for many callers, bound to the tenant, aged out', async () => {
  let t = 0;
  const msal = fakeMsal({ clock: () => t, delayMs: 10 });
  const s = session(msal, () => t, HOUR);
  await Promise.all(['A', 'B', 'C'].map((x) => s.getToken([`${x}.Read.All`])));
  assert.equal(msal.interactive, 1);
  assert.equal((await s.getToken(['User.Read'])).accessToken, 'silent:User.Read');
  t += 2 * HOUR;
  await s.ensureSignedIn();
  assert.equal(msal.interactive, 2, 'past the maximum age the next call signs in again');
  await s.signOut();
  assert.equal(s.isSignedIn(), false);

  const wrong = fakeMsal({ clock: () => 0, tenantId: OTHER });
  const w = session(wrong, () => 0);
  await assert.rejects(w.getToken(['User.Read']), /bound to 1111/);
  assert.equal(w.isSignedIn(), false);
  assert.equal(wrong.accounts.length, 0, 'an account from another tenant is never kept');
});

test('sign-in: writes go to the write session when there is one', async () => {
  const readMsal = fakeMsal({ clock: () => 0, label: 'r-' });
  const writeMsal = fakeMsal({ clock: () => 0, label: 'w-' });
  const sessions = { read: session(readMsal, () => 0), write: session(writeMsal, () => 0) };
  assert.equal((await answerTokenRequest(sessions, { scopes: ['User.Read.All'] })).accessToken, 'r-interactive:User.Read.All');
  assert.equal(writeMsal.interactive, 0);
  assert.equal((await answerTokenRequest(sessions, { scopes: ['User.ReadWrite.All'], access: 'write' })).accessToken, 'w-interactive:User.ReadWrite.All');
  const shared = { read: session(fakeMsal({ clock: () => 0, label: 's-' }), () => 0) };
  assert.equal((await answerTokenRequest(shared, { scopes: ['User.ReadWrite.All'], access: 'write' })).accessToken, 's-interactive:User.ReadWrite.All');
});

const stdioFixture = resolve('test/fixtures/stdio-server.ts');
const graphService = { name: 'entra', transport: 'stdio', command: process.execPath, args: ['--no-env-file', stdioFixture], signIn: true, timeout: 5000 };

test('sign-in: configuration binds it to a GUID tenant and keeps it off by default', async () => {
  assert(fileConfigSchema.safeParse({ signIn: { clientId: 'wellknown' }, services: [graphService] }).success);
  assert(!fileConfigSchema.safeParse({ services: [graphService] }).success, 'signIn: true needs the block');
  assert(!fileConfigSchema.safeParse({ signIn: { clientId: 'not-a-guid' }, services: [graphService] }).success);
  assert(!fileConfigSchema.safeParse({ signIn: { clientId: TENANT, writeClientId: TENANT }, services: [graphService] }).success);
  assert(!fileConfigSchema.safeParse({ signIn: { clientId: 'wellknown', writeClientId: 'wellknown' }, services: [graphService] }).success);
  for (const key of ['MCP_GRAPH_TOKEN_BROKER', 'GATEWAY_EXPECTED_TENANT_ID']) {
    assert(!fileConfigSchema.safeParse({ services: [{ ...graphService, signIn: false, env: { [key]: '1' } }] }).success, key);
  }
  const plain = childEnvironment({ ...graphService, transport: 'stdio', args: [], env: {}, signIn: false }, TENANT, {});
  assert.equal(plain.MCP_GRAPH_TOKEN_BROKER, undefined);
  const lent = childEnvironment({ ...graphService, transport: 'stdio', args: [], env: {} }, TENANT, {});
  assert.equal(lent.MCP_GRAPH_TOKEN_BROKER, '1');
  assert.equal(lent.GATEWAY_EXPECTED_TENANT_ID, TENANT);

  const dir = await mkdtemp(join(tmpdir(), 'mcp-signin-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ signIn: { clientId: 'wellknown' }, services: [graphService] }));
    await assert.rejects(loadConfig({ TENANT_ID: 'tenant-acme', MCP_CONFIG_PATH: path }), /TENANT_ID/);
    const config = await loadConfig({ TENANT_ID: TENANT, MCP_CONFIG_PATH: path });
    assert.equal(config.signIn?.sessionMaxAgeHours, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sign-in: a real stdio plane borrows tokens over its pipe, and only signed-in services can', { timeout: 20_000 }, async () => {
  const readMsal = fakeMsal({ clock: Date.now, label: 'r-' });
  const writeMsal = fakeMsal({ clock: Date.now, label: 'w-' });
  let built = 0;
  const config = await (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-signin-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({
      signIn: { clientId: 'wellknown' },
      services: [graphService, { ...graphService, name: 'plain', signIn: false }],
    }));
    try { return await loadConfig({ TENANT_ID: TENANT, MCP_CONFIG_PATH: path }); } finally { await rm(dir, { recursive: true, force: true }); }
  })();
  const manager = new DownstreamManager(config, async () => {
    built++;
    return { read: session(readMsal, Date.now), write: session(writeMsal, Date.now) };
  });
  try {
    await manager.start();
    assert.equal(built, 0, 'no sign-in until a signed-in service is called');
    const env = await manager.call('entra', { name: 'whoami' }, new AbortController().signal);
    const data = env.structuredContent as Record<string, unknown>;
    assert.equal(data.broker, '1');
    assert.equal(data.expectedTenant, TENANT);
    assert.equal(readMsal.interactive, 1, 'the browser opened before the call, once');

    const read = await manager.call('entra', { name: 'graph_token', arguments: {} }, new AbortController().signal);
    assert.equal((read.structuredContent as { accessToken: string }).accessToken, 'r-silent:User.Read.All');
    const write = await manager.call('entra', { name: 'graph_token', arguments: { access: 'write', scopes: ['User.ReadWrite.All'] } }, new AbortController().signal);
    assert.equal((write.structuredContent as { accessToken: string }).accessToken, 'w-interactive:User.ReadWrite.All');
    const refused = await manager.call('entra', { name: 'graph_token', arguments: { scopes: ['https://graph.microsoft.com/.default'] } }, new AbortController().signal);
    assert.equal(refused.isError, true);

    const plain = await manager.call('plain', { name: 'graph_token', arguments: {} }, new AbortController().signal);
    assert.equal(plain.isError, true, 'a service without signIn cannot borrow a token');
    const plainEnv = (await manager.call('plain', { name: 'whoami' }, new AbortController().signal)).structuredContent as Record<string, unknown>;
    assert.equal(plainEnv.broker, null);
    assert.equal(built, 1);
  } finally {
    await manager.close();
  }
  assert.equal(readMsal.accounts.length, 0, 'closing the gateway forgets the account');
});
