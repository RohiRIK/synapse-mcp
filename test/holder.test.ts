import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHolderSessions,
  ensureHolder,
  holderRequest,
  holderSocketPath,
  HolderUnavailableError,
} from '../src/holder.js';
import type { BrokerSessions } from '../src/signin.js';
import { SIGN_OUT_METHOD } from '../src/signin.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const FAKE = fileURLToPath(new URL('./fixtures/fake-holder.ts', import.meta.url));

/** The holder is Unix-socket based and Synapse never uses it on Windows; its socket tests run where it runs. */
const SOCKETS = process.platform !== 'win32';
let home = '';
beforeEach(() => {
  home = mkdtempSync(SOCKETS ? '/tmp/s-' : join(tmpdir(), 's-'));
});
afterEach(async () => {
  await holderRequest(holderSocketPath(TENANT, CLIENT, home), SIGN_OUT_METHOD, {}, 2_000).catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
});

const noLocal = async (): Promise<BrokerSessions> => {
  throw new Error('must not sign in locally while a holder answers');
};
const ensure = () => ensureHolder({
  tenantId: TENANT, clientId: CLIENT, maxSessionAgeMs: 60_000, home,
  launch: { command: process.execPath, args: [FAKE] },
});

test('the socket name matches microsoft-graph-mcp-servers exactly', () => {
  // Pinned from mcp_shared's holderSocketPath for the same inputs.
  expect(holderSocketPath(TENANT, CLIENT, '/h')).toBe(join('/h', '.mcp-graph', 'run', 'signin-15228cf443e65784.sock'));
});

test.skipIf(!SOCKETS)('three Synapse runs share one sign-in, and stopping one does not end it', async () => {
  const tokens: string[] = [];
  for (let run = 0; run < 3; run++) {
    const sessions = createHolderSessions(ensure, noLocal, () => undefined);
    await sessions.read.ensureSignedIn();
    tokens.push((await sessions.read.getToken(['User.Read.All'])).accessToken);
    expect(sessions.shared).toBe(true);
  }
  expect(tokens).toEqual(['prompts=1', 'prompts=1', 'prompts=1']);
  expect(existsSync(holderSocketPath(TENANT, CLIENT, home))).toBe(true);
}, 30_000);

test.skipIf(!SOCKETS)('sign-out ends the shared holder', async () => {
  const sessions = createHolderSessions(ensure, noLocal, () => undefined);
  await sessions.read.getToken(['User.Read.All']);
  await sessions.read.signOut();
  await Bun.sleep(100);
  expect(existsSync(holderSocketPath(TENANT, CLIENT, home))).toBe(false);
}, 30_000);

test('a socket path over the macOS limit counts as no holder', async () => {
  await expect(holderRequest(`/tmp/${'x'.repeat(120)}.sock`, 'x-mcp-graph/status')).rejects.toBeInstanceOf(HolderUnavailableError);
});

test('no holder can start: Synapse signs in for itself and says so', async () => {
  const warnings: string[] = [];
  let local = 0;
  const own: BrokerSessions = {
    read: {
      getToken: async () => ({ accessToken: 'own', expiresOn: Date.now() + 3_600_000 }),
      ensureSignedIn: async () => {
        local++;
      },
      signOut: async () => undefined,
      isSignedIn: () => true,
      flow: 'interactive',
      access: 'read',
      needsSignIn: () => false,
      beginSignIn: () => ({ code: Promise.resolve(null), done: Promise.resolve() }),
      cancelSignIn: () => {},
    },
  };
  const sessions = createHolderSessions(
    async () => {
      throw new HolderUnavailableError('none');
    },
    async () => own,
    (message) => warnings.push(message),
  );
  await sessions.read.ensureSignedIn();
  expect((await sessions.read.getToken(['User.Read.All'])).accessToken).toBe('own');
  expect(local).toBe(1);
  expect(warnings).toHaveLength(1);
});
