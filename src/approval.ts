import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * A confirm-gated call runs only when a person approves it in the MCP client.
 *
 * Downstream tools gate a dangerous action behind a boolean `confirm` argument: called without
 * it they answer with a preview (`structuredContent.type === 'confirmation_required'`) and run
 * nothing. The model is the one that sends `confirm: true`, so on its own that proves only that
 * the model read the preview. Synapse is the one process connected to the client, so it asks the
 * client to show the preview to the person (MCP elicitation) and forwards the confirmed call only
 * if they accept. A model cannot answer an elicitation; a person can.
 *
 * Fail closed: a client that cannot show an elicitation, or any error while asking, runs nothing.
 */

export type ApprovalOutcome = 'approved' | 'declined' | 'unsupported';

/** The part of the MCP server needed to ask the client. Injected, so tests need no client. */
export interface ApprovalChannel {
  readonly supportsElicitation: () => boolean;
  readonly ask: (message: string) => Promise<{ action: string; content?: Record<string, unknown> | undefined }>;
}

/** A tool is confirm-gated when its input schema has a boolean `confirm`. */
export function isConfirmGated(inputSchema: unknown): boolean {
  const properties = (inputSchema as { properties?: Record<string, { type?: unknown } | undefined> } | undefined)?.properties;
  return properties?.confirm?.type === 'boolean';
}

/** One checkbox the person must tick, plus accepting the dialog. */
export const APPROVAL_SCHEMA = {
  type: 'object' as const,
  properties: {
    approve: {
      type: 'boolean' as const,
      title: 'I approve this change',
      description: 'Tick and accept to run it. Decline or cancel and nothing runs.',
    },
  },
  required: ['approve'],
};

/** How long a person has to answer before the call is treated as not approved. */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

const MAX_MESSAGE = 6000;

export function approvalMessage(tool: string, tenant: string, preview: string): string {
  const body = preview.length > MAX_MESSAGE ? `${preview.slice(0, MAX_MESSAGE)}\n… (preview shortened)` : preview;
  return `Approve ${tool} in tenant ${tenant}?\n\n${body}`;
}

export async function requestApproval(
  channel: ApprovalChannel, tool: string, tenant: string, preview: string,
): Promise<ApprovalOutcome> {
  if (!channel.supportsElicitation()) return 'unsupported';
  try {
    const answer = await channel.ask(approvalMessage(tool, tenant, preview));
    return answer.action === 'accept' && answer.content?.approve === true ? 'approved' : 'declined';
  } catch {
    // A client that advertised elicitation but failed to show it has not approved anything.
    return 'unsupported';
  }
}

export const NOT_APPROVED =
  'Not approved in the client, so nothing ran. The person declined or cancelled the approval prompt. '
  + 'Do not retry unless they ask for it again.';

export const CANNOT_ASK =
  'This client cannot show an approval prompt (MCP elicitation), so nothing ran. A confirm-gated change '
  + "needs a person's approval in the client.";

const refusal = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** The downstream's instructions to the model are not for the person reading the dialog. */
export function previewForPerson(result: CallToolResult): string {
  return result.content
    .map((item) => (item.type === 'text' ? item.text : ''))
    .join('\n')
    .replace(/\nTo proceed, the AI MUST:[\s\S]*?If the user says no, do NOT call the tool again\.\n?/, '\n');
}

/**
 * A call that arrived with `confirm: true`:
 *   1. the same call with `confirm: false`: the downstream answers with its preview and runs nothing;
 *   2. that preview goes to the person, in the client;
 *   3. only if they approve, the confirmed call.
 * A tool whose first answer is not a confirmation preview has no confirmation step: that answer
 * stands, and the tool is not called a second time.
 */
export async function runApproved(options: {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly tenant: string;
  readonly channel: ApprovalChannel;
  readonly call: (args: Record<string, unknown>) => Promise<CallToolResult>;
  readonly onOutcome?: (outcome: ApprovalOutcome) => void;
}): Promise<CallToolResult> {
  const preview = await options.call({ ...options.input, confirm: false });
  if ((preview.structuredContent as { type?: unknown } | undefined)?.type !== 'confirmation_required') return preview;
  const outcome = await requestApproval(options.channel, options.name, options.tenant, previewForPerson(preview));
  options.onOutcome?.(outcome);
  if (outcome === 'unsupported') return refusal(CANNOT_ASK);
  if (outcome === 'declined') return refusal(NOT_APPROVED);
  return options.call({ ...options.input, confirm: true });
}
