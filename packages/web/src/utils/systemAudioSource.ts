import { getElectronAPI } from '../platform/platform';

/**
 * System audio without Backspace's own playback, on the desktop app where
 * Chromium's loopback cannot leave it out (#358, Linux). The main process
 * routes every other app's playback into a virtual PipeWire source
 * (packages/desktop/src/systemAudio.ts); here that source is opened like a
 * microphone and its track replaces the loopback track of the share.
 */

/** How long the virtual source gets to show up in the device list after the link is made. */
const DEVICE_WAIT_MS = 3000;
const DEVICE_POLL_MS = 150;

/** `null` when the desktop app has no such source (or this is a browser): the caller keeps the loopback capture. */
export async function acquireAppExcludedSystemAudio(): Promise<MediaStreamTrack | null> {
  const api = getElectronAPI();
  if (!api?.startSystemAudio || !api.stopSystemAudio) return null;

  let started: Awaited<ReturnType<NonNullable<typeof api.startSystemAudio>>>;
  try {
    started = await api.startSystemAudio();
  } catch (err) {
    console.warn('[ScreenShare] The system-audio source could not be started:', err);
    return null;
  }
  if (!started.ok) return null;

  const release = (): void => {
    void api.stopSystemAudio?.().catch(() => undefined);
  };

  try {
    const deviceId = await waitForDevice(started.label);
    if (!deviceId) {
      console.warn('[ScreenShare] The system-audio source did not appear in the device list');
      release();
      return null;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    const track = stream.getAudioTracks()[0];
    if (!track) {
      release();
      return null;
    }
    // The link lives as long as the track: stopping it, by any path that
    // stops a capture track, takes the source down.
    const stopTrack = track.stop.bind(track);
    track.stop = (): void => {
      stopTrack();
      release();
    };
    track.addEventListener('ended', release, { once: true });
    return track;
  } catch (err) {
    console.warn('[ScreenShare] The system-audio source could not be opened:', err);
    release();
    return null;
  }
}

async function waitForDevice(label: string): Promise<string | null> {
  const deadline = Date.now() + DEVICE_WAIT_MS;
  for (;;) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const found = devices.find((d) => d.kind === 'audioinput' && d.label.includes(label));
    if (found) return found.deviceId;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, DEVICE_POLL_MS));
  }
}
