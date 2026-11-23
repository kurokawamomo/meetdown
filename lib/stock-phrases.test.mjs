import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STOCK_PHRASES, stripStockPhrases } from './stock-phrases.mjs';
import { createSpeech } from './speech.mjs';

test('an utterance made only of a stock phrase becomes empty, with or without punctuation', () => {
  for (const t of [
    'ご視聴ありがとうございました',
    'ご視聴ありがとうございました。',
    ' ご清聴ありがとうございました。 ',
    'ご清聴ありがとうございました！',
    'チャンネル登録お願いします',
    'チャンネル登録よろしくお願いします。',
    'Thank you for watching',
    'Thank you for watching.',
    'thank you for watching!',
    'Thanks  for   watching',
    'Please subscribe.',
  ]) assert.equal(stripStockPhrases(t), '', t);
});

test('every phrase in the list is dropped when it stands alone', () => {
  for (const p of STOCK_PHRASES) assert.equal(stripStockPhrases(p), '', p);
  for (const p of STOCK_PHRASES) assert.equal(stripStockPhrases(p + '。'), '', p);
});

test('a stock phrase at the end of a real remark is cut off, the remark stays', () => {
  assert.equal(stripStockPhrases('明日の会議は十時からです。ご視聴ありがとうございました。'), '明日の会議は十時からです。');
  assert.equal(stripStockPhrases('明日の会議は十時からです ご清聴ありがとうございました'), '明日の会議は十時からです');
  assert.equal(stripStockPhrases('That is all for today. Thank you for watching.'), 'That is all for today.');
  assert.equal(stripStockPhrases('次の議題に進みましょう、チャンネル登録お願いします。'), '次の議題に進みましょう');
});

test('several stock phrases in a row are all removed', () => {
  assert.equal(stripStockPhrases('ご視聴ありがとうございました。チャンネル登録お願いします。'), '');
  assert.equal(stripStockPhrases('報告は以上です。ご視聴ありがとうございました。ご清聴ありがとうございました。'), '報告は以上です。');
});

test('a stock phrase inside a remark, or at its start, is left alone', () => {
  assert.equal(stripStockPhrases('ご視聴ありがとうございましたと言われた'), 'ご視聴ありがとうございましたと言われた');
  assert.equal(stripStockPhrases('ご視聴ありがとうございました。次の話題です'), 'ご視聴ありがとうございました。次の話題です');
  assert.equal(stripStockPhrases('Thank you for watching the demo yesterday'), 'Thank you for watching the demo yesterday');
});

test('ordinary text, empty text, and non-text come through unchanged or empty', () => {
  assert.equal(stripStockPhrases('今日はよろしくお願いします。'), '今日はよろしくお願いします。');
  assert.equal(stripStockPhrases('  hello  '), 'hello');
  assert.equal(stripStockPhrases(''), '');
  assert.equal(stripStockPhrases('   '), '');
  assert.equal(stripStockPhrases(null), '');
  assert.equal(stripStockPhrases(undefined), '');
});

// speech.transcribe runs the voice module's result through the filter and leaves the other fields alone
function speechWith(result) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetdown-voice-'));
  const file = path.join(dir, 'voice.js');
  fs.writeFileSync(file, `
    exports.MAX_AUDIO = 1234;
    exports.Voice = class { constructor() {} start() { return { ok: true }; } cancel() {} shutdown() {}
      async transcribe() { return ${JSON.stringify(result)}; } };
  `);
  const speech = createSpeech({ stateDir: path.join(dir, 'state'), audioDir: path.join(dir, 'audio'), voiceModule: file });
  return { speech, dir };
}

test('speech.transcribe drops a stock phrase made from silence and keeps ms', async () => {
  const { speech, dir } = speechWith({ text: 'ご視聴ありがとうございました。', ms: 120 });
  try {
    assert.deepEqual(await speech.transcribe(Buffer.alloc(1)), { text: '', ms: 120 });
  } finally { speech.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('speech.transcribe cuts a stock phrase off the end of a remark', async () => {
  const { speech, dir } = speechWith({ text: '了解しました。ご清聴ありがとうございました。', ms: 80 });
  try {
    assert.deepEqual(await speech.transcribe(Buffer.alloc(1)), { text: '了解しました。', ms: 80 });
  } finally { speech.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('speech.transcribe passes an error result through untouched', async () => {
  const { speech, dir } = speechWith({ error: 'whisper is down', ms: 0 });
  try {
    assert.deepEqual(await speech.transcribe(Buffer.alloc(1)), { error: 'whisper is down', ms: 0 });
  } finally { speech.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});
