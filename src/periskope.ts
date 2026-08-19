import { config } from './config';

/**
 * The slice of the Periskope API this service needs: editing an existing
 * group's name and description. Same auth headers and base URL as the sibling
 * services (Authorization bearer + x-phone).
 */

export class PeriskopeError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = 'PeriskopeError';
    this.status = status;
    this.details = details;
  }
}

async function call<T>(
  method: 'GET' | 'POST',
  pathname: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${config.periskope.baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${config.periskope.apiKey}`,
      'x-phone': config.periskope.phone,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new PeriskopeError(
      `Periskope ${method} ${pathname} returned ${res.status}: ${text.slice(0, 500)}`,
      res.status,
      data
    );
  }

  return data as T;
}

/** Send a message into a chat (group JID or {number}@c.us for an individual). */
export function sendMessage(chatId: string, message: string): Promise<unknown> {
  return call('POST', '/message/send', { chat_id: chatId, message });
}

/**
 * Update a group's name (subject) and/or description.
 * POST /chats/{chat_id}/settings -- both fields are optional; pass only what
 * changes. See docs.periskope.app/api-reference/chat/update-group-settings.
 */
export function updateGroupSettings(
  chatId: string,
  settings: { name?: string; description?: string }
): Promise<unknown> {
  const body: Record<string, string> = {};
  if (settings.name !== undefined) body.name = settings.name;
  if (settings.description !== undefined) body.description = settings.description;
  return call('POST', `/chats/${encodeURIComponent(chatId)}/settings`, body);
}
