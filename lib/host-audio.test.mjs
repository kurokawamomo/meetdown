import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAssertions, parseDevices, parseVolume, createHostAudio } from './host-audio.mjs';

const PMSET = `Assertion status system-wide:
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 335(powerd): [0x0029054600019ccc] 00:20:29 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"  
   pid 418(coreaudiod): [0x00290a0b0001a42a] 00:00:08 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInSpeakerDevice.context.preventuseridlesleep"  
\tCreated for PID: 45572. 
\tResources: audio-out BuiltInSpeakerDevice 
   pid 418(coreaudiod): [0x00290a020001a446] 00:00:17 PreventUserIdleSystemSleep named: "com.apple.audio.AVVCAggregateDevice-1420-282475249.context.preventuseridlesleep"  
\tCreated for PID: 1420. 
\tResources: audio-in audio-out BuiltInSpeakerDevice 
   pid 795(useractivityd): [0x00290a130001a4a7] 00:00:00 PreventUserIdleSystemSleep named: "BTLEAdvertisement.C4E288D2"  
\tTimeout will fire in 59 secs Action=TimeoutActionTurnOff
`;
const PROFILER = JSON.stringify({ SPAudioDataType: [{ _items: [
  { _name: 'PHL 242E2F', coreaudio_device_srate: 48000, coreaudio_device_transport: 'coreaudio_device_type_hdmi' },
  { _name: 'Mic', coreaudio_default_audio_input_device: 'spaudio_yes', coreaudio_device_srate: 48000, coreaudio_device_transport: 'coreaudio_device_type_builtin' },
  { _name: 'Speaker', coreaudio_default_audio_output_device: 'spaudio_yes', coreaudio_device_srate: 44100, coreaudio_device_transport: 'coreaudio_device_type_builtin' },
] }] });
const VOLUME = 'output volume:38, input volume:71, alert volume:100, output muted:false';

test('host-audio: only coreaudiod assertions are kept, with who they were made for and what they hold', () => {
  const a = parseAssertions(PMSET);
  assert.equal(a.length, 2);
  assert.deepEqual(a[0], { name: 'BuiltInSpeakerDevice', forPid: 45572, resources: 'audio-out BuiltInSpeakerDevice' });
  assert.deepEqual(a[1], { name: 'AVVCAggregateDevice-1420-282475249', forPid: 1420, resources: 'audio-in audio-out BuiltInSpeakerDevice' });
});

test('host-audio: the default output and input devices are picked out', () => {
  const d = parseDevices(PROFILER);
  assert.deepEqual(d.output, { name: 'Speaker', sampleRate: 44100, transport: 'builtin' });
  assert.deepEqual(d.input, { name: 'Mic', sampleRate: 48000, transport: 'builtin' });
  assert.deepEqual(d.all, ['PHL 242E2F', 'Mic', 'Speaker']);
  assert.equal(parseDevices('not json'), null);
});

test('host-audio: volume and mute', () => {
  assert.deepEqual(parseVolume(VOLUME), { outputVolume: 38, inputVolume: 71, outputMuted: false });
  assert.deepEqual(parseVolume('output volume:0, input volume:5, alert volume:1, output muted:true'), { outputVolume: 0, inputVolume: 5, outputMuted: true });
  assert.equal(parseVolume('garbage'), null);
});

function rig(overrides = {}) {
  let t = 1000;
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(cmd);
    if (overrides[cmd] !== undefined) return overrides[cmd];
    if (cmd === 'pmset') return PMSET;
    if (cmd === 'system_profiler') return PROFILER;
    if (cmd === 'osascript') return VOLUME;
    if (cmd === 'ps') return '/System/Library/PrivateFrameworks/CoreSpeech.framework/corespeechd\n';
    return null;
  };
  const host = createHostAudio({ run, now: () => t, minGapMs: 5000 });
  return { host, calls, at: (ms) => { t += ms; } };
}

test('host-audio: a look puts devices, volume, who holds the speakers and the cause in one line', async () => {
  const r = rig();
  const line = await r.host.look({ event: 'play-start', seq: 7, at: '2026-11-23T01:00:00.000Z', data: { id: 'u9' } });
  assert.equal(line.event, 'host-audio');
  assert.equal(line.output.name, 'Speaker');
  assert.equal(line.outputVolume, 38);
  assert.equal(line.outputMuted, false);
  assert.equal(line.assertions[1].forProcess, 'corespeechd');
  assert.deepEqual(line.cause, { event: 'play-start', seq: 7, at: '2026-11-23T01:00:00.000Z', id: 'u9' });
  assert.equal(line.errors, undefined);
});

test('host-audio: events that are not play-start, mic-open, mic-close or ctx-create are ignored', async () => {
  const r = rig();
  assert.equal(await r.host.look({ event: 'unlock' }), null);
  assert.equal(await r.host.look(null), null);
  assert.equal(r.calls.length, 0);
});

test('host-audio: no second look within the gap; one after it', async () => {
  const r = rig();
  assert.ok(await r.host.look({ event: 'mic-open' }));
  r.at(4999);
  assert.equal(await r.host.look({ event: 'play-start' }), null);
  r.at(1);
  assert.ok(await r.host.look({ event: 'mic-close' }));
});

test('host-audio: a command that fails or times out is named in errors and the rest is still reported', async () => {
  const r = rig({ pmset: null, osascript: null });
  const line = await r.host.look({ event: 'mic-open' });
  assert.deepEqual(line.errors, ['pmset', 'osascript']);
  assert.equal(line.assertions, null);
  assert.equal(line.output.name, 'Speaker');
});

test('host-audio: a run that throws gives null, and the next look still works', async () => {
  let boom = true;
  let t = 0;
  const host = createHostAudio({ run: async (cmd) => { if (boom) throw new Error('x'); return cmd === 'system_profiler' ? PROFILER : null; }, now: () => t, minGapMs: 10 });
  assert.equal(await host.look({ event: 'mic-open' }), null);
  boom = false;
  t = 100;
  assert.ok(await host.look({ event: 'mic-open' }));
});
