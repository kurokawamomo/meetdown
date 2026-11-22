"""meetdown speech worker. Reads one JSON object per line on stdin, writes a wav per sentence, and reports one JSON line per event.
In:  {"id": 12, "text": "...", "voice": "<speaker>", "style": "<style>"} / {"cancel": [12, 13]}
Out: {"ready": true} / {"id": 12, "seq": 0, "file": "12-0.wav", "sec": 1.2, "gap": 0.5, "last": false} / {"id": 12, "done": true} / {"id": 12, "error": "..."}
Sentence splitting and voice loading come from the local VOICEVOX tts skill (tts_gen.py)."""
import asyncio, io, json, os, queue, sys, threading, wave

sys.path.insert(0, os.path.expanduser("~/.claude/skills/tts/scripts"))
from tts_gen import SR, gap, load, split, write_wav  # noqa: E402

OUT = sys.argv[1]
SPEED = float(os.environ.get("MEETDOWN_SPEED") or 1)  # speaking speed, 1.0 = VOICEVOX default
jobs, cancelled, lock = queue.Queue(), set(), threading.Lock()


def tell(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def reader():
    for line in sys.stdin:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if "cancel" in m:
            with lock:
                cancelled.update(m["cancel"])
        else:
            jobs.put(m)
    jobs.put(None)


def main():
    run = asyncio.new_event_loop().run_until_complete
    voices = {}
    threading.Thread(target=reader, daemon=True).start()
    tell({"ready": True})
    for m in iter(jobs.get, None):
        uid = m["id"]
        key = (m.get("voice"), m.get("style"))
        try:
            if not all(key):
                tell({"id": uid, "error": "voice and style are not set for this participant"})
                continue
            if key not in voices:
                voices[key] = run(load(*key))
            if not voices[key]:
                tell({"id": uid, "error": f"voice not found: {key[0]} / {key[1]}"})
                continue
            syn, sid = voices[key]
            chunks = split(m["text"])
            for i, c in enumerate(chunks):
                with lock:
                    if uid in cancelled:
                        break
                if SPEED == 1:
                    data = run(syn.tts(c, sid))
                else:
                    q = run(syn.create_audio_query(c, sid))
                    q.speed_scale = SPEED
                    data = run(syn.synthesis(q, sid))
                r = wave.open(io.BytesIO(data))
                pcm = r.readframes(r.getnframes())
                name = f"{uid}-{i}.wav"
                write_wav(os.path.join(OUT, name), pcm)
                last = i == len(chunks) - 1
                tell({"id": uid, "seq": i, "file": name, "sec": round(len(pcm) / 2 / SR, 3), "gap": gap(c, last), "last": last, "text": c})
            tell({"id": uid, "done": True})
        except Exception as e:
            tell({"id": uid, "error": str(e)})


if __name__ == "__main__":
    try:
        main()
    finally:
        # VOICEVOX threads can touch Python after shutdown and panic, so skip the shutdown (same as tts_gen.py)
        sys.stdout.flush()
        os._exit(0)
