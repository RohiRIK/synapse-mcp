import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileConfigSchema, loadConfig } from '../src/config.js';
import { childEnvironment, DownstreamManager } from '../src/downstream.js';
import { deviceCodeSignIn, SIGN_IN_DECLINED, type SignInChannel } from '../src/device-code.js';
import {
  answerTokenRequest, assertGraphScopes, createMemorySession, type MsalAccountLike, type MsalLike, type MsalResultLike,
  type SignInFlow,
} from '../src/signin.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const HOUR = 3_600_000;

type FakeMsal = MsalLike & {
  interactive: number; deviceCodes: number; cancelled: number; accounts: MsalAccountLike[];
  /** The person enters the device code: the pending poll returns. */
  enterCode(): void;
};
function fakeMsal(opts: { tenantId?: string; clock: () => number; delayMs?: number; label?: string }): FakeMsal {
  let entered = false;
  const msal: FakeMsal = {
    interactive: 0,
    deviceCodes: 0,
    cancelled: 0,
    accounts: [],
    enterCode() { entered = true; },
    async acquireTokenByDeviceCode(request): Promise<MsalResultLike> {
      msal.deviceCodes++;
      entered = false;
      request.deviceCodeCallback({ userCode: `CODE${msal.deviceCodes}`, verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900 });
      while (!entered) {
        if (request.cancel) { msal.cancelled++; throw new Error('Token request cancelled'); }
        await new Promise((done) => setTimeout(done, 5));
      }
      const account = { tenantId: opts.tenantId ?? TENANT, homeAccountId: 'a', username: 'u@example.test' };
      msal.accounts = [account];
      return { accessToken: `${opts.label ?? ''}device:${request.scopes.join(' ')}`, expiresOn: new Date(opts.clock() + HOUR), account };
    },
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
const session = (msal: MsalLike, clock: () => number, maxSessionAgeMs = 8 * HOUR, flow: SignInFlow = 'interactive') => createMemorySession({
  msal, tenantId: TENANT, maxSessionAgeMs, openBrowser: async () => {}, selectAccountPrompt: 'select_account', now: clock, flow,
});
const text = (result: { content: Array<{ type: string; text?: string }> } | null) => result?.content.map((item) => item.text ?? '').join('\n') ?? '';
const until = async (check: () => boolean) => {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 5));
  }
};

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

test('sign-in: a device code session signs in once for many callers, bound to the tenant, and can be stopped', async () => {
  const msal = fakeMsal({ clock: () => 0 });
  const s = session(msal, () => 0, HOUR, 'device_code');
  assert.equal(s.needsSignIn(), true);
  const first = s.beginSignIn();
  const code = await first.code;
  assert.equal(code?.userCode, 'CODE1');
  assert.equal(code?.access, 'read');
  const waiting = Promise.all([s.getToken(['User.Read.All']), s.getToken(['Group.Read.All'])]);
  assert.equal(s.beginSignIn(), first, 'a second caller joins the sign-in in progress');
  msal.enterCode();
  await first.done;
  await waiting;
  assert.equal(msal.deviceCodes, 1);
  assert.equal(s.needsSignIn(), false);
  assert.equal(msal.interactive, 0, 'no browser on a device code session');

  const stopped = session(fakeMsal({ clock: () => 0 }), () => 0, HOUR, 'device_code');
  const pending = stopped.beginSignIn();
  await pending.code;
  stopped.cancelSignIn();
  await assert.rejects(pending.done, /cancelled/);
  assert.equal(stopped.isSignedIn(), false);

  const wrong = fakeMsal({ clock: () => 0, tenantId: OTHER });
  const w = session(wrong, () => 0, HOUR, 'device_code');
  const signing = w.getToken(['User.Read']);
  await w.beginSignIn().code;
  wrong.enterCode();
  await assert.rejects(signing, /bound to 1111/);
  assert.equal(wrong.accounts.length, 0, 'an account from another tenant is never kept');
});

const channel = (answer: string | Error, onAsk?: (message: string) => void): SignInChannel & { asked: number } => {
  const c = {
    asked: 0,
    supportsElicitation: () => true,
    ask: async (message: string) => {
      c.asked++;
      onAsk?.(message);
      if (answer instanceof Error) throw answer;
      return { action: answer, content: answer === 'accept' ? { signedIn: true } : undefined };
    },
  };
  return c;
};

test('sign-in: the device code reaches the person in the client, or the model when the client cannot ask', async () => {
  // Interactive, or already signed in: nothing to show.
  assert.equal(await deviceCodeSignIn(session(fakeMsal({ clock: () => 0 }), () => 0), channel('accept'), TENANT), null);

  // The client can ask: the call waits for the person, then goes ahead.
  const msal = fakeMsal({ clock: () => 0 });
  const s = session(msal, () => 0, HOUR, 'device_code');
  let shown = '';
  const asks = channel('accept', (message) => { shown = message; msal.enterCode(); });
  assert.equal(await deviceCodeSignIn(s, asks, TENANT, () => 0), null);
  assert.match(shown, /https:\/\/microsoft\.com\/devicelogin/);
  assert.match(shown, /CODE1/);
  assert.match(shown, new RegExp(TENANT));
  assert.equal(s.isSignedIn(), true);
  assert.equal(await deviceCodeSignIn(s, asks, TENANT), null, 'signed in: no second prompt');
  assert.equal(asks.asked, 1);

  // The person declines: polling stops and nothing runs.
  const declined = fakeMsal({ clock: () => 0 });
  const d = session(declined, () => 0, HOUR, 'device_code');
  assert.equal(await deviceCodeSignIn(d, channel('decline'), TENANT), SIGN_IN_DECLINED);
  assert.equal(declined.cancelled, 1);
  assert.equal(d.isSignedIn(), false);

  // No way to ask: the code goes back as the answer, keeps polling, and the retry goes through.
  for (const fallback of [undefined, { supportsElicitation: () => false, ask: async () => ({ action: 'accept' }) }, channel(new Error('not shown'))]) {
    const quiet = fakeMsal({ clock: () => 0 });
    const q = session(quiet, () => 0, HOUR, 'device_code');
    const result = await deviceCodeSignIn(q, fallback, TENANT, () => 0);
    assert.equal(result?.isError, true);
    assert.match(text(result), /CODE1/);
    assert.match(text(result), /nothing ran/);
    assert.match(text(result), /Do not enter the code yourself/);
    assert.match(text(await deviceCodeSignIn(q, fallback, TENANT)), /CODE1/, 'same code until it is used');
    quiet.enterCode();
    await until(() => q.isSignedIn());
    assert.equal(await deviceCodeSignIn(q, fallback, TENANT), null);
    assert.equal(quiet.deviceCodes, 1);
  }
});

const stdioFixture = resolve('test/fixtures/stdio-server.ts');
const graphService = { name: 'entra', transport: 'stdio', command: process.execPath, args: ['--no-env-file', stdioFixture], signIn: true, timeout: 5000 };

test('sign-in: configuration binds it to a GUID tenant and keeps it off by default', async () => {
  assert(fileConfigSchema.safeParse({ signIn: { clientId: 'wellknown' }, services: [graphService] }).success);
  assert(!fileConfigSchema.safeParse({ services: [graphService] }).success, 'signIn: true needs the block');
  assert(!fileConfigSchema.safeParse({ signIn: { clientId: 'not-a-guid' }, services: [graphService] }).success);
  assert(!fileConfigSchema.safeParse({ signIn: { clientId: TENANT, writeClientId: TENANT }, services: [graphService] }).success);
  assert(!fileConfigSchema.safeParse({ signIn: { clientId: 'wellknown', writeClientId: 'wellknown' }, services: [graphService] }).success);
  assert.equal(fileConfigSchema.parse({ signIn: { clientId: 'wellknown' }, services: [graphService] }).signIn?.flow, 'interactive');
  assert.equal(fileConfigSchema.parse({ signIn: { clientId: 'wellknown', flow: 'device_code' }, services: [graphService] }).signIn?.flow, 'device_code');
  assert(!fileConfigSchema.safeParse({ signIn: { clientId: 'wellknown', flow: 'browser' }, services: [graphService] }).success);
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

test('sign-in: device code through a real stdio plane, for a client that cannot ask and one that can', { timeout: 20_000 }, async () => {
  const readMsal = fakeMsal({ clock: Date.now, label: 'r-' });
  const writeMsal = fakeMsal({ clock: Date.now, label: 'w-' });
  const config = await (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-signin-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ signIn: { clientId: 'wellknown', flow: 'device_code' }, services: [graphService] }));
    try { return await loadConfig({ TENANT_ID: TENANT, MCP_CONFIG_PATH: path }); } finally { await rm(dir, { recursive: true, force: true }); }
  })();
  const manager = new DownstreamManager(config, async () => ({
    read: session(readMsal, Date.now, 8 * HOUR, 'device_code'),
    write: createMemorySession({
      msal: writeMsal, tenantId: TENANT, maxSessionAgeMs: HOUR, openBrowser: async () => {}, selectAccountPrompt: 'select_account',
      flow: 'device_code', access: 'write',
    }),
  }));
  const signal = new AbortController().signal;
  try {
    await manager.start();
    // No channel: the code comes back and the plane is never called.
    const first = await manager.call('entra', { name: 'graph_token', arguments: {} }, signal);
    assert.equal(first.isError, true);
    assert.match(text(first), /CODE1/);
    readMsal.enterCode();
    await until(() => readMsal.accounts.length === 1);
    const read = await manager.call('entra', { name: 'graph_token', arguments: {} }, signal);
    assert.equal((read.structuredContent as { accessToken: string }).accessToken, 'r-silent:User.Read.All');

    // A write token asked for mid-call, with no way to ask: the plane is told the code instead.
    const midCall = await manager.call('entra', { name: 'graph_token', arguments: { access: 'write', scopes: ['User.ReadWrite.All'] } }, signal);
    assert.equal(midCall.isError, true);
    assert.match(text(midCall), /for changes \(write\)[\s\S]*CODE1/);

    // An approved change signs the write identity in first, through the client (the same code, still good).
    const prompts: string[] = [];
    manager.signInChannel = channel('accept', (message) => { prompts.push(message); writeMsal.enterCode(); });
    const write = await manager.call('entra', { name: 'graph_token', arguments: { access: 'write', scopes: ['User.ReadWrite.All'] } }, signal, { write: true });
    assert.equal((write.structuredContent as { accessToken: string }).accessToken, 'w-silent:User.ReadWrite.All');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /for changes \(write\)[\s\S]*CODE1/);
    assert.equal(writeMsal.deviceCodes, 1);
    assert.equal(readMsal.deviceCodes, 1);
  } finally {
    await manager.close();
  }
  assert.equal(readMsal.accounts.length, 0, 'closing the gateway forgets the account');
});

test('sign-in: the Microsoft Graph example config is valid as shipped', async () => {
  const { readFile } = await import('node:fs/promises');
  const parsed = fileConfigSchema.safeParse(JSON.parse(await readFile(resolve('examples/microsoft-graph.config.json'), 'utf8')));
  assert(parsed.success);
  assert.deepEqual(parsed.data.services.map((service) => service.name), ['entra', 'intune', 'exchange', 'defender', 'purview']);
  assert(parsed.data.services.every((service) => service.transport === 'stdio' && service.signIn));
});
