/**
 * System audio for a screen share without Backspace's own playback (#358).
 *
 * Chromium can leave the app out of a loopback capture only on Windows 11 and
 * macOS 14.2+ (docs/systems/voice.md, "System Audio Loopback"). On Linux the
 * capture is the monitor of the whole mix, so the voices Backspace plays come
 * back to the viewers. Here the capture is built from the other side: PipeWire
 * is asked (through `@vencord/venmic`, the module Vesktop uses) to route every
 * playback stream except Backspace's own into a virtual source, and the web
 * client opens that source like a microphone.
 *
 * This file only decides what to exclude and drives the link; the PipeWire
 * work is venmic's. The module is an optional dependency that exists on Linux
 * only, so it is loaded lazily and everything here degrades to "unavailable".
 */

/** Name venmic gives the virtual source; the web client finds the device by it. */
export const SYSTEM_AUDIO_SOURCE_LABEL = 'vencord-screen-share';

/** A PipeWire node's properties, matched by exact string equality. */
export type NodeMatch = Record<string, string>;

/** The part of `@vencord/venmic`'s `PatchBay` used here. */
export interface PatchBayLike {
  link(data: { exclude: NodeMatch[]; only_speakers: boolean; ignore_devices: boolean }): boolean;
  unlink(): void;
}

export interface PatchBayModule {
  PatchBay: (new () => PatchBayLike) & { hasPipeWire(): boolean };
}

export type SystemAudioStart =
  | { ok: true; label: string }
  | { ok: false; reason: 'unsupported-platform' | 'module-missing' | 'no-pipewire' | 'link-failed' };

export interface SystemAudioController {
  /** Whether `start` can work on this machine (platform, module, PipeWire). The module load is cached, the probe is not: PipeWire may come up later. */
  isAvailable(): boolean;
  start(): SystemAudioStart;
  stop(): void;
}

export interface SystemAudioDeps {
  platform: NodeJS.Platform;
  loadModule: () => PatchBayModule;
  /** Pids of every process of this Electron app (`app.getAppMetrics()`). */
  getPids: () => number[];
  /** `process.execPath`: the binary every Electron process of the app runs. */
  executablePath: string;
  log?: (message: string, ...args: unknown[]) => void;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * What to keep out of the virtual source. Matches are OR'd between entries and
 * AND'd inside one. The playback stream belongs to Chromium's audio-service
 * process, so each of the app's pids is listed; the binary name is added as
 * well because a sandboxed process can report a pid from its own namespace,
 * which no list of host pids would match.
 */
export function buildExcludeNodes(pids: readonly number[], executablePath: string): NodeMatch[] {
  const nodes: NodeMatch[] = [...new Set(pids)]
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => ({ 'application.process.id': String(pid) }));
  const binary = baseName(executablePath);
  if (binary) nodes.push({ 'application.process.binary': binary });
  return nodes;
}

export function createSystemAudioController(deps: SystemAudioDeps): SystemAudioController {
  const log = deps.log ?? (() => undefined);
  let module: PatchBayModule | null | undefined;
  let bay: PatchBayLike | null = null;
  let linked = false;

  function load(): PatchBayModule | null {
    if (module !== undefined) return module;
    if (deps.platform !== 'linux') return (module = null);
    try {
      module = deps.loadModule();
    } catch (err) {
      log('venmic could not be loaded:', err);
      module = null;
    }
    return module;
  }

  function reason(): Extract<SystemAudioStart, { ok: false }>['reason'] | null {
    if (deps.platform !== 'linux') return 'unsupported-platform';
    const loaded = load();
    if (!loaded) return 'module-missing';
    try {
      if (!loaded.PatchBay.hasPipeWire()) return 'no-pipewire';
    } catch (err) {
      log('PipeWire probe failed:', err);
      return 'no-pipewire';
    }
    return null;
  }

  return {
    isAvailable: () => reason() === null,

    start(): SystemAudioStart {
      const unavailable = reason();
      if (unavailable) return { ok: false, reason: unavailable };
      try {
        bay ??= new (module as PatchBayModule).PatchBay();
        // A second start relinks with the pids as they are now.
        const ok = bay.link({
          exclude: buildExcludeNodes(deps.getPids(), deps.executablePath),
          only_speakers: true,
          ignore_devices: true,
        });
        linked = ok;
        if (!ok) return { ok: false, reason: 'link-failed' };
        return { ok: true, label: SYSTEM_AUDIO_SOURCE_LABEL };
      } catch (err) {
        log('venmic link failed:', err);
        linked = false;
        return { ok: false, reason: 'link-failed' };
      }
    },

    stop(): void {
      if (!bay || !linked) return;
      linked = false;
      try {
        bay.unlink();
      } catch (err) {
        log('venmic unlink failed:', err);
      }
    },
  };
}

/**
 * `ownAudioInSystemAudio()` describes what Chromium's loopback does. When this
 * module can build the capture instead, Backspace's own playback is left out
 * whatever the OS table says.
 */
export function withSystemAudioSource<T extends string>(base: T, sourceAvailable: boolean): T | 'excluded' {
  return sourceAvailable ? 'excluded' : base;
}
