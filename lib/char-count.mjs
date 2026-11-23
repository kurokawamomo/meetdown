// Hands-free listening sends every loud stretch it recorded; the server keeps it as speech only when the
// transcript has enough letters. Spaces and punctuation do not count (Whisper can answer a cough with "。" or "...").

export function charCount(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}]/gu) || []).length;
}

// min <= 0 or not a number: nothing is too short
export function tooShort(text, min) {
  return Number(min) > 0 && charCount(text) < Number(min);
}
