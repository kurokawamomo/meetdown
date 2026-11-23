// Courier: builds the one-line messages that go into participants' tmux panes and keeps each
// participant's read position on the Participant object that roster.byName() returns:
//   cursor  - id of the last utterance the participant was told about
//   noticed - id up to which their cut-off remarks were already reported
// Transport is injected: send(pane, text, opts) resolves false (or throws) when the pane did not take the message.

const DIGEST_KINDS = new Set(['voice', 'text', 'say']);
const DIGEST_MAX = 10;
const CLIP_LENGTH = 80;
const ELLIPSIS = '\u2026';

const oneLine = (s) => String(s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
const clip = (s, n) => {
  const chars = [...s]; // by code point, so surrogate pairs are not cut in half
  return chars.length > n ? chars.slice(0, n).join('') + ELLIPSIS : s;
};
const nameOf = (p) => p.label || p.name;
const messageOf = (e) => (e && e.message) || String(e);

export function createCourier({ send, sayPath = 'meet-say', guidePath = '', owner = 'the user', log = () => {}, onFail = () => {} }) {
  if (typeof send !== 'function') throw new TypeError('createCourier: send must be a function');

  const meetingIdOf = (meeting) => meeting.info().id;
  const lastIdOf = (meeting) => meeting.list.reduce((max, x) => Math.max(max, x.id), 0);
  const labelOf = (roster, name) => (name === 'human' ? owner : (roster.byName(name) || {}).label || name);

  // What was said since the participant last heard, newest 10, never their own remarks
  function digestOf(meeting, roster, p, before = Infinity) {
    const after = p.cursor ?? 0;
    return meeting.list
      .filter((x) => x.id > after && x.id < before && x.from !== p.name && x.text && DIGEST_KINDS.has(x.kind))
      .slice(-DIGEST_MAX)
      .map((x) => `${labelOf(roster, x.from)}: "${clip(oneLine(x.text), CLIP_LENGTH)}"`)
      .join(' ');
  }

  // The participant's latest remark that the human cut off or that was never played, if not reported yet
  function cutNoteOf(meeting, p) {
    const cut = meeting.list
      .filter((x) => x.from === p.name && x.kind === 'say' && x.id > (p.noticed ?? 0) && (x.play === 'cut' || x.play === 'dropped'))
      .pop();
    if (!cut) return '';
    if (cut.play === 'dropped') return ' / Your previous remark was not played.';
    return ` / Your previous remark was cut off${Number.isInteger(cut.cutAt) ? ` during sentence ${cut.cutAt + 1}` : ''}.`;
  }

  function report(kind, p, why) {
    log('courier', kind, 'not sent to', p.name, why);
    try { onFail({ kind, name: p.name, label: nameOf(p), why }); } catch (_) { /* a failing callback must not stop delivery */ }
  }

  // Sends one message to one participant. Resolves true when the pane took it; never throws.
  async function post(kind, p, text, tag) {
    if (!p.pane) { report(kind, p, 'no-pane'); return false; }
    let why = '';
    try {
      const ok = await send(p.pane, text, { log: (...a) => log('pane', ...a), tag, onGiveup: (w) => { why = String(w); } });
      if (ok === false) { report(kind, p, why || 'not-delivered'); return false; }
      return true;
    } catch (e) {
      report(kind, p, 'send-error: ' + messageOf(e));
      return false;
    }
  }

  // Runs one job per name in parallel (each pane has its own queue downstream) and keeps the names that were sent
  async function eachName(kind, roster, names, job) {
    const sent = await Promise.all([...new Set(names || [])].map(async (name) => {
      try {
        const p = roster.byName(name);
        if (!p) { report(kind, { name }, 'not-in-meeting'); return null; }
        return (await job(p)) ? name : null;
      } catch (e) {
        log('courier', kind, 'failed for', name, messageOf(e));
        return null;
      }
    }));
    return sent.filter(Boolean);
  }

  // The read position moves before the send, so two quick messages do not repeat each other,
  // and moves back when the pane did not take the message, so the next one carries what was missed.
  async function withReadPosition(p, next, sendIt) {
    const prev = { cursor: p.cursor, noticed: p.noticed };
    Object.assign(p, next);
    const ok = await sendIt();
    if (!ok && Object.keys(next).every((k) => p[k] === next[k])) Object.assign(p, prev);
    return ok;
  }

  // A human utterance (voice or text) to the named participants, with the digest and how to reply
  function deliver(meeting, roster, u, names) {
    const id = meetingIdOf(meeting);
    return eachName('deliver', roster, names, (p) => {
      const speaker = u.from === 'human' ? owner : labelOf(roster, u.from);
      const digest = digestOf(meeting, roster, p, u.id);
      const text = `[meetdown ${speaker} (${u.kind === 'voice' ? 'voice' : 'text'}${u.aside ? ', aside' : ''})] ${oneLine(u.text)}`
        + (digest ? ` / Since you last heard: ${digest}` : '')
        + cutNoteOf(meeting, p)
        + ` (meeting ${id}; you are ${nameOf(p)}. Reply by running ${sayPath} "what to say": spoken style, 1-3 sentences, in the language of the message. Text-only replies are not heard in the meeting.)`
        + (u.aside ? ' This is an aside for you only; the others will see it later in the minutes.' : '');
      const next = { cursor: Math.max(p.cursor ?? 0, u.id), noticed: Math.max(p.noticed ?? 0, lastIdOf(meeting)) };
      return withReadPosition(p, next, () => post('deliver', p, text, `u${u.id}`));
    });
  }

  // New remarks for participants who were not addressed. A participant with nothing new is skipped.
  function share(meeting, roster, names) {
    const id = meetingIdOf(meeting);
    const last = lastIdOf(meeting);
    return eachName('share', roster, names, (p) => {
      const digest = digestOf(meeting, roster, p);
      if (!digest) return false;
      const text = `[meetdown share] Since you last heard: ${digest} (meeting ${id}; you are ${nameOf(p)}. No reply needed. Only if you have something important to add, say one sentence with ${sayPath} "...".)`;
      // Shares carry no cut-off note, so only the cursor moves
      return withReadPosition(p, { cursor: Math.max(p.cursor ?? 0, last) }, () => post('share', p, text, 'share'));
    });
  }

  const listOf = (v) => [].concat(v ?? []);
  const live = (roster) => roster.participants().filter((p) => p.status !== 'absent');

  // A human utterance to everyone. Holders of the baton are asked to answer by voice (or pass it),
  // the others to listen only. No digest: everyone hears everything. Cut-off notes still go out.
  function broadcast(meeting, roster, u, holders) {
    const id = meetingIdOf(meeting);
    const holding = new Set(listOf(holders));
    const batonLabels = [...holding].map((n) => labelOf(roster, n)).join(', ') || 'none';
    const names = live(roster).map((p) => p.name).filter((n) => n !== u.from);
    return eachName('broadcast', roster, names, (p) => {
      const speaker = u.from === 'human' ? owner : labelOf(roster, u.from);
      const head = `[meetdown ${speaker} (${u.kind === 'voice' ? 'voice' : 'text'}; baton: ${batonLabels})] ${oneLine(u.text)}` + cutNoteOf(meeting, p);
      const how = holding.has(p.name)
        ? `You hold the baton: answer by running ${sayPath} "what to say" (spoken style, 1-3 sentences, in the language of the message), or pass it with ${sayPath} --pass <name> "why". Text-only replies are not heard in the meeting.`
        : `You do not hold the baton: listen only; if you have nothing important, do nothing (no reply needed). If you must speak, run ${sayPath} --murmur "..."; if nobody holds the baton, take it with ${sayPath} --take "what to say".`;
      const text = `${head} (meeting ${id}; you are ${nameOf(p)}. ${how})`;
      const next = { cursor: Math.max(p.cursor ?? 0, u.id ?? 0), noticed: Math.max(p.noticed ?? 0, lastIdOf(meeting)) };
      return withReadPosition(p, next, () => post('broadcast', p, text, `u${u.id}`));
    });
  }

  // A piece of what the human is still saying: nobody answers yet. Read positions do not move.
  function interim(meeting, roster, text, turn) {
    const id = meetingIdOf(meeting);
    return eachName('interim', roster, live(roster).map((p) => p.name), (p) => {
      const line = `[meetdown ${owner} (still talking)] ${oneLine(text)} (meeting ${id}; you are ${nameOf(p)}. ${owner} is still talking: do not answer yet; murmur with ${sayPath} --murmur "..." only if important.)`;
      return post('interim', p, line, `i${turn}`);
    });
  }

  // The baton was passed from one participant to another; only the receivers are told
  function passed(meeting, roster, from, to, text) {
    const id = meetingIdOf(meeting);
    const giver = labelOf(roster, from);
    return eachName('passed', roster, listOf(to), (p) => {
      const line = `[meetdown ${giver} (passed the baton to you)] ${oneLine(text)} (meeting ${id}; you are ${nameOf(p)}. You hold the baton now: answer by running ${sayPath} "what to say" (spoken style, 1-3 sentences), or pass it on with ${sayPath} --pass <name> "why".)`;
      return post('passed', p, line, `pass-${p.name}`);
    });
  }

  async function greet(meeting, roster, p) {
    const others = roster.participants().filter((x) => x.name !== p.name).map(nameOf).join(', ') || 'none';
    const text = `[meetdown] You joined meeting ${meetingIdOf(meeting)} as ${nameOf(p)}. Others: ${others}. Messages for you start with [meetdown ...]; reply with ${sayPath} "...".${guidePath ? ` Before you speak, read ${guidePath} (how to talk in this meeting).` : ''} If the baton reaches you by a word meant for someone else, run ${sayPath} --route <word> <name> (add --once for this meeting only). No reply needed now.`;
    return post('greet', p, text, `greet-${p.name}`);
  }

  async function dismiss(meeting, p) {
    const text = `[meetdown] You left meeting ${meetingIdOf(meeting)}. No reply needed. Do not run meet-say for this meeting anymore.`;
    return post('dismiss', p, text, `dismiss-${p.name}`);
  }

  async function shareClosed(meeting, p) {
    const text = `[meetdown] The owner closed your screen share in meeting ${meetingIdOf(meeting)}. No reply needed; share again only if asked.`;
    return post('shareClosed', p, text, `share-closed-${p.name}`);
  }

  // The closing notice goes out even when the summary text is empty, so the participants still learn that the meeting is over
  function summary(meeting, roster, summaryText) {
    const body = oneLine(summaryText);
    const text = `[meetdown summary] Meeting ${meetingIdOf(meeting)} ended.${body ? ' ' + body : ''} (No reply needed. Do not run meet-say.)`;
    return eachName('summary', roster, roster.participants().map((p) => p.name), (p) => post('summary', p, text, 'summary'));
  }

  // The public methods never throw or reject: a failure is logged and counts as "nothing sent"
  const guard = (kind, fn, fallback) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      log('courier', kind, 'failed', messageOf(e));
      return fallback;
    }
  };

  return {
    deliver: guard('deliver', deliver, []),
    share: guard('share', share, []),
    broadcast: guard('broadcast', broadcast, []),
    interim: guard('interim', interim, []),
    passed: guard('passed', passed, []),
    greet: guard('greet', greet, false),
    dismiss: guard('dismiss', dismiss, false),
    shareClosed: guard('shareClosed', shareClosed, false),
    summary: guard('summary', summary, []),
  };
}
