import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DeviceCodePrompt, MemorySession } from './signin.js';

/**
 * Getting a device code to the person, for an agent whose Synapse runs where nobody can see it.
 *
 * The code is shown in the MCP client (elicitation) when the client can ask, and the call waits
 * there until the sign-in finishes. A client that cannot ask gets the code back as the tool's
 * answer instead, for the model to pass on, and nothing runs; the code keeps polling, so the
 * same call made again after the person has entered it goes through.
 *
 * The person typing the code in is what signs in, so a model relaying it grants nothing by itself.
 * The tenant lock in src/signin.ts still drops an account from any other directory.
 */

export interface SignInChannel {
  readonly supportsElicitation: () => boolean;
  readonly ask: (message: string, timeoutMs: number) => Promise<{ action: string; content?: Record<string, unknown> | undefined }>;
}

/** One checkbox; accepting the dialog means "I've done it", declining stops the sign-in. */
export const DEVICE_CODE_SCHEMA = {
  type: 'object' as const,
  properties: {
    signedIn: {
      type: 'boolean' as const,
      title: 'I entered the code and signed in',
      description: 'Accept once you have signed in. Decline or cancel to stop the sign-in; nothing runs.',
    },
  },
};

const minutesLeft = (prompt: DeviceCodePrompt, now: number) => Math.max(1, Math.round((prompt.expiresAt - now) / 60_000));

const what = (prompt: DeviceCodePrompt) =>
  prompt.access === 'write' ? 'Microsoft sign-in for changes (write)' : 'Microsoft sign-in';

export function deviceCodeMessage(prompt: DeviceCodePrompt, tenant: string, now = Date.now()): string {
  return `${what(prompt)} needed for tenant ${tenant}.\n\n`
    + `On any device, open ${prompt.verificationUri} and enter the code ${prompt.userCode}. `
    + `Sign in with an account from this tenant. The code expires in about ${minutesLeft(prompt, now)} minutes.\n\n`
    + 'Accept here once you have signed in.';
}

/** For a client that cannot ask: the model passes the code on, and nothing ran. */
export function deviceCodeResult(prompt: DeviceCodePrompt, tenant: string, now = Date.now()): CallToolResult {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `${what(prompt)} needed, so nothing ran. Ask the person to open ${prompt.verificationUri} on any device `
        + `and enter the code ${prompt.userCode}, signing in with an account from tenant ${tenant}. `
        + `The code expires in about ${minutesLeft(prompt, now)} minutes. `
        + 'Once they say they have signed in, make the same call again. Do not enter the code yourself.',
    }],
  };
}

export const SIGN_IN_DECLINED: CallToolResult = {
  isError: true,
  content: [{
    type: 'text',
    text: 'The person stopped the Microsoft sign-in in the client, so nothing ran. Do not retry unless they ask for it again.',
  }],
};

/**
 * Make sure a device code session is signed in before a call needs it.
 * Returns null to go ahead, or the answer to give instead of running the call.
 * A browser session, or one already signed in, goes ahead untouched.
 */
export async function deviceCodeSignIn(
  session: MemorySession, channel: SignInChannel | undefined, tenant: string, now: () => number = Date.now,
): Promise<CallToolResult | null> {
  if (session.flow !== 'device_code' || !session.needsSignIn()) return null;
  const { code, done } = session.beginSignIn();
  const first = await Promise.race([code, done.then(() => null)]);
  if (!first) {
    await done; // throws the sign-in's own error, if it failed before a code was issued
    return null;
  }
  if (!channel?.supportsElicitation()) return deviceCodeResult(first, tenant, now());
  let answer: Awaited<ReturnType<SignInChannel['ask']>>;
  try {
    answer = await channel.ask(deviceCodeMessage(first, tenant, now()), Math.max(1_000, first.expiresAt - now()));
  } catch {
    // The client said it could ask and then did not show it. The code is still good; hand it over.
    return deviceCodeResult(first, tenant, now());
  }
  if (answer.action !== 'accept') {
    session.cancelSignIn();
    await done.catch(() => {});
    return SIGN_IN_DECLINED;
  }
  await done; // finishes when Microsoft sees the code used, or fails when it expires
  return null;
}
