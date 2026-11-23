// Whisper invents stock phrases out of silence and noise (a video outro it saw in its training data).
// This drops an utterance that is only such a phrase, and cuts such a phrase off the end of a real one.

// Add a phrase here to have it dropped. Case, spaces, and trailing punctuation around a phrase do not matter.
export const STOCK_PHRASES = [
  // Japanese
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  '最後までご視聴いただきありがとうございました',
  'ご清聴ありがとうございました',
  'ご清聴ありがとうございます',
  'チャンネル登録お願いします',
  'チャンネル登録よろしくお願いします',
  'チャンネル登録をお願いします',
  'チャンネル登録お願いいたします',
  // English
  'Thank you for watching',
  'Thanks for watching',
  'Thank you so much for watching',
  'Thank you for listening',
  'Please subscribe',
  'Please subscribe to my channel',
  'Please subscribe to the channel',
];

// After a phrase, spaces and sentence punctuation of both scripts may follow. Before the first one, only spaces and
// commas are taken, so the real remark keeps its own full stop.
const GAP = '[\\s、，,。．.!！?？…・~〜]*';
const LEAD = '[\\s、，,]*';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest first, so a phrase that contains another is matched whole
const ALTERNATION = [...STOCK_PHRASES]
  .sort((a, b) => b.length - a.length)
  .map((p) => escape(p).replace(/ /g, '\\s+'))
  .join('|');
const TRAILING = new RegExp(`(?:${LEAD}(?:${ALTERNATION})${GAP})+$`, 'iu');

// -> the text without stock phrases at its end; '' when nothing but stock phrases was said
export function stripStockPhrases(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  return trimmed.replace(TRAILING, '').trim();
}
