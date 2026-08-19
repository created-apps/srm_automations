import { config } from './config';

/**
 * Slack is outbound only here: a one-line note when a case's setup finishes or
 * fails. chat:write is the only scope needed. Failures to post are swallowed --
 * a Slack outage must never fail the setup that just succeeded.
 */
export async function postNote(text: string): Promise<void> {
  try {
    const res = await fetch(`${config.slack.baseUrl}/chat.postMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        authorization: `Bearer ${config.slack.botToken}`,
      },
      body: JSON.stringify({
        channel: config.slack.channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!data?.ok) {
      console.error('Slack postMessage failed:', data?.error ?? `HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('Slack postMessage threw:', err);
  }
}

/** A dashboard deep-link to a case, when DASHBOARD_URL is configured. */
export function caseLink(caseId: string): string {
  return config.dashboard.url ? `${config.dashboard.url}/cases/${caseId}` : caseId;
}
