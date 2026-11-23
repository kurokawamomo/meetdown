// What the Mac itself says about audio, taken beside the page's own report (state/audio-diag.jsonl, event
// "host-audio"). When a voice plays inside the page (the level is not zero) but nobody hears it, this shows
// where the sound was delivered: which devices coreaudiod holds open and for whom, the default output and input
// devices, and the output volume and mute. The server runs on the same Mac as the browser.
// The commands are run by `run(cmd, args)`, which resolves to the output text or null when it failed or timed out.

export const WANTED = new Set(['play-start', 'mic-open', 'mic-close', 'ctx-create']);
const MAX_ASSERTIONS = 8;

const base = (p) => String(p || '').split('/').pop();

// `pmset -g assertions`: the coreaudiod lines. Each has a name, "Created for PID" and "Resources".
export function parseAssertions(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*pid (\d+)\(([^)]*)\):.*named: "([^"]*)"/);
    if (!m || m[2] !== 'coreaudiod') continue;
    const a = { name: m[3].replace(/^com\.apple\.audio\./, '').replace(/\.context\.[a-z]+$/i, ''), forPid: null, resources: '' };
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && !/^\s*pid \d+\(/.test(lines[j]); j++) {
      const c = lines[j].match(/Created for PID:\s*(\d+)/);
      const r = lines[j].match(/Resources:\s*(.*)$/);
      if (c) a.forPid = Number(c[1]);
      if (r) a.resources = r[1].trim();
    }
    out.push(a);
  }
  return out.slice(0, MAX_ASSERTIONS);
}

// `system_profiler SPAudioDataType -json`
export function parseDevices(text) {
  let items = [];
  try { items = JSON.parse(text).SPAudioDataType.flatMap((g) => g._items || []); } catch (_) { return null; }
  const pick = (flag) => {
    const d = items.find((x) => x[flag] === 'spaudio_yes');
    return d ? { name: d._name, sampleRate: d.coreaudio_device_srate, transport: String(d.coreaudio_device_transport || '').replace('coreaudio_device_type_', '') } : null;
  };
  return {
    output: pick('coreaudio_default_audio_output_device'),
    input: pick('coreaudio_default_audio_input_device'),
    all: items.map((d) => d._name).filter(Boolean),
  };
}

// `osascript -e 'get volume settings'`: "output volume:38, input volume:71, alert volume:100, output muted:false"
export function parseVolume(text) {
  const t = String(text || '');
  const num = (k) => { const m = t.match(new RegExp(k + ':(\\d+)')); return m ? Number(m[1]) : null; };
  const muted = t.match(/output muted:(true|false)/);
  if (!/output volume/.test(t)) return null;
  return { outputVolume: num('output volume'), inputVolume: num('input volume'), outputMuted: muted ? muted[1] === 'true' : null };
}

export function createHostAudio({ run, now = () => Date.now(), minGapMs = 5000 } = {}) {
  let last = -Infinity;
  let busy = false;

  async function snapshot() {
    const errors = [];
    const [pm, sp, vol] = await Promise.all([
      run('pmset', ['-g', 'assertions']),
      run('system_profiler', ['SPAudioDataType', '-json']),
      run('osascript', ['-e', 'get volume settings']),
    ]);
    const assertions = pm == null ? (errors.push('pmset'), null) : parseAssertions(pm);
    const devices = sp == null ? (errors.push('system_profiler'), null) : parseDevices(sp);
    const volume = vol == null ? (errors.push('osascript'), null) : parseVolume(vol);
    if (assertions) {
      await Promise.all(assertions.filter((a) => a.forPid).map(async (a) => {
        const name = await run('ps', ['-p', String(a.forPid), '-o', 'comm=']);
        if (name && name.trim()) a.forProcess = base(name.trim());
      }));
    }
    return { event: 'host-audio', output: devices && devices.output, input: devices && devices.input, devices: devices && devices.all, ...(volume || {}), assertions, errors: errors.length ? errors : undefined };
  }

  // The event that makes us look (an object with an event name); resolves to the line to write, or null when
  // it is not an event we look at, is too soon after the last look, or one is already running
  async function look(cause) {
    if (!cause || !WANTED.has(cause.event)) return null;
    const t = now();
    if (busy || t - last < minGapMs) return null;
    busy = true;
    last = t;
    try {
      const snap = await snapshot();
      return { ...snap, cause: { event: cause.event, seq: cause.seq, at: cause.at, id: cause.data && cause.data.id } };
    } catch (_) {
      return null;
    } finally {
      busy = false;
    }
  }

  return { look, snapshot };
}
