// Turns a batch of page audio diagnostics (POST /api/audio-diag) into JSONL lines for state/audio-diag.jsonl.
// The file is separate from the meeting records on purpose: minutes and summaries are made from those.
// The page is not trusted: the batch is cut to MAX_EVENTS, anything that is not a plain object or that serializes
// to more than MAX_LINE characters is dropped, and string fields are cut short.

export const MAX_EVENTS = 100;
export const MAX_LINE = 4096;

const cut = (v, n) => String(v ?? '').slice(0, n);

export function diagLines(body, now = new Date()) {
  const b = body && typeof body === 'object' ? body : {};
  const list = Array.isArray(b.events) ? b.events.slice(0, MAX_EVENTS) : [];
  const head = { server: now.toISOString(), page: cut(b.page, 40), ua: cut(b.ua, 300) };
  const lines = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const line = JSON.stringify({ ...head, ...e, server: head.server, page: head.page, ua: head.ua });
    if (line.length <= MAX_LINE) lines.push(line);
  }
  return lines;
}
