import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  startSystemAudio: vi.fn(),
  stopSystemAudio: vi.fn(),
}));
const platform = vi.hoisted(() => ({ getElectronAPI: vi.fn() }));
vi.mock('../platform/platform', () => platform);

import { acquireAppExcludedSystemAudio } from './systemAudioSource';

/**
 * #358: on the Linux desktop app the system audio of a share is the virtual
 * source the main process builds without Backspace's own playback. The track
 * must come from that source and take it down again when it stops.
 */

function fakeTrack() {
  const listeners = new Map<string, () => void>();
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn((type: string, fn: () => void) => listeners.set(type, fn)),
  };
  return { track: track as unknown as MediaStreamTrack, raw: track, listeners };
}

function stubMedia(devices: Array<Partial<MediaDeviceInfo>>, track: MediaStreamTrack | undefined) {
  const getUserMedia = vi.fn(async () => ({ getAudioTracks: () => (track ? [track] : []) }));
  const enumerateDevices = vi.fn(async () => devices as MediaDeviceInfo[]);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices } });
  return { getUserMedia, enumerateDevices };
}

beforeEach(() => {
  api.startSystemAudio.mockReset();
  api.stopSystemAudio.mockReset().mockResolvedValue(undefined);
  platform.getElectronAPI.mockReset().mockReturnValue(api);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('acquireAppExcludedSystemAudio', () => {
  it('returns null in a browser and on a desktop app without the bridge', async () => {
    platform.getElectronAPI.mockReturnValue(undefined);
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    platform.getElectronAPI.mockReturnValue({});
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
  });

  it('returns null, and opens nothing, when the main process has no source', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: false, reason: 'no-pipewire' });
    const media = stubMedia([], undefined);
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
  });

  it('returns null when starting throws', async () => {
    api.startSystemAudio.mockRejectedValue(new Error('ipc'));
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
  });

  it('opens the virtual source by its device id, without voice processing', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const { track } = fakeTrack();
    const media = stubMedia(
      [
        { kind: 'audioinput', label: 'Default', deviceId: 'default' },
        { kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'virt-1' },
      ],
      track,
    );
    expect(await acquireAppExcludedSystemAudio()).toBe(track);
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'virt-1' },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    expect(api.stopSystemAudio).not.toHaveBeenCalled();
  });

  it('takes the source down when the track stops or ends', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const stopped = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], stopped.track);
    const originalStop = stopped.raw.stop;
    const track = await acquireAppExcludedSystemAudio();
    track!.stop();
    expect(originalStop).toHaveBeenCalledTimes(1);
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);

    api.stopSystemAudio.mockClear();
    const ended = fakeTrack();
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], ended.track);
    await acquireAppExcludedSystemAudio();
    ended.listeners.get('ended')!();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('waits for a source that shows up late', async () => {
    vi.useFakeTimers();
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const { track } = fakeTrack();
    const media = stubMedia([{ kind: 'audioinput', label: 'Default', deviceId: 'default' }], track);
    media.enumerateDevices
      .mockResolvedValueOnce([{ kind: 'audioinput', label: 'Default', deviceId: 'default' }] as MediaDeviceInfo[])
      .mockResolvedValueOnce([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'late' }] as MediaDeviceInfo[]);
    const pending = acquireAppExcludedSystemAudio();
    await vi.advanceTimersByTimeAsync(400);
    expect(await pending).toBe(track);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('gives up, and unlinks, when the source never appears', async () => {
    vi.useFakeTimers();
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const media = stubMedia([{ kind: 'audioinput', label: 'Default', deviceId: 'default' }], undefined);
    const pending = acquireAppExcludedSystemAudio();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toBeNull();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('unlinks when the device cannot be opened', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    const media = stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], undefined);
    media.getUserMedia.mockRejectedValue(new DOMException('busy', 'NotReadableError'));
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('unlinks when the opened stream has no audio track', async () => {
    api.startSystemAudio.mockResolvedValue({ ok: true, label: 'vencord-screen-share' });
    stubMedia([{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'v' }], undefined);
    expect(await acquireAppExcludedSystemAudio()).toBeNull();
    expect(api.stopSystemAudio).toHaveBeenCalledTimes(1);
  });
});
