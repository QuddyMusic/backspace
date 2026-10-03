// TTS voice bot: joins the voice channel of whoever calls it, speaks, and
// leaves after 10 idle seconds. Speech comes from Piper (English and Russian); the audio goes out
// through the LiveKit client library, one room connection per channel.
//
//   BACKSPACE_URL=https://chat.example.com BOT_TOKEN=... node tts.mjs
//
// /tts <text>  joins your voice channel (if needed) and says the text
// /stop        leaves your voice channel at once
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import {
  AudioFrame, AudioSource, LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackSource,
} from '@livekit/rtc-node';
import { createBot } from '../client.mjs';

const IDLE_MS = 10_000;
const MAX_TEXT = 300;
const PIPER = process.env.PIPER_BIN ?? '/opt/piper/piper';
const VOICES_DIR = process.env.PIPER_VOICES ?? '/opt/piper/voices';
const MODELS = { ru: 'ru_RU-irina-medium.onnx', en: 'en_US-lessac-medium.onnx' };
const SAMPLE_RATE = 22_050; // what espeak-ng produces
const CHANNELS = 1;
const FRAME = SAMPLE_RATE / 50; // 20 ms = 441 samples, a whole number (10 ms would be 220.5)
const LEAD = new Int16Array(Math.floor(SAMPLE_RATE * 0.2)); // silence before, so the first word is not clipped
const TAIL = new Int16Array(Math.floor(SAMPLE_RATE * 0.3)); // silence after

const bot = createBot({ baseUrl: process.env.BACKSPACE_URL, token: process.env.BOT_TOKEN });

const seats = new Map();    // user id -> voice channel id they sit in
const sessions = new Map(); // channel id -> Promise<session>, one seat per channel

const commands = [
  {
    name: 'tts',
    description: 'Say a phrase in your voice channel',
    options: [{ name: 'text', description: 'What to say', type: 'string', required: true }],
  },
  { name: 'stop', description: 'Leave your voice channel' },
];

// LiveKit source is created at SAMPLE_RATE, so every voice must match it.
for (const file of Object.values(MODELS)) {
  const meta = JSON.parse(readFileSync(`${VOICES_DIR}/${file}.json`, 'utf8'));
  if (meta.audio?.sample_rate !== SAMPLE_RATE) throw new Error(`${file} is not ${SAMPLE_RATE} Hz`);
}

/** Runs of one language: Cyrillic words are Russian, Latin words English; digits and punctuation follow the word before them. */
function splitByLanguage(text) {
  let current = /[\u0400-\u04FF]/.test(text) ? 'ru' : 'en';
  const runs = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (/[\u0400-\u04FF]/.test(word)) current = 'ru';
    else if (/[A-Za-z]/.test(word)) current = 'en';
    const last = runs[runs.length - 1];
    if (last && last.lang === current) last.text += ` ${word}`;
    else runs.push({ lang: current, text: word });
  }
  return runs;
}

/** One run to 16-bit mono PCM with Piper. The text goes through stdin, never through argv. */
function piperRun(lang, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(PIPER, ['--model', `${VOICES_DIR}/${MODELS[lang]}`, '--output_raw']);
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', () => { /* drained so the pipe never blocks */ });
    child.stdin.on('error', () => { /* the exit code below reports the failure */ });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`piper exited with ${code}`)); return; }
      const bytes = Buffer.concat(chunks);
      const samples = new Int16Array(Math.floor(bytes.length / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
      resolve(samples);
    });
    child.stdin.end(`${text.replace(/\s+/g, ' ')}\n`);
  });
}

async function synthesize(text) {
  const parts = [];
  for (const run of splitByLanguage(text)) parts.push(await piperRun(run.lang, run.text));
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return all;
}

function armIdle(session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => { void closeSession(session.channelId); }, IDLE_MS);
}

async function openSession(channelId) {
  if (!bot.send({ type: 'bot_voice_join', channelId })) throw new Error('not connected to the server');
  const room = new Room();
  try {
    const { token, url } = await bot.api('POST', '/livekit/token', { channelId });
    await room.connect(url, token, { autoSubscribe: false });
    const source = new AudioSource(SAMPLE_RATE, CHANNELS);
    const track = LocalAudioTrack.createAudioTrack('tts', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant.publishTrack(track, options);
    const session = { channelId, room, source, queue: Promise.resolve(), timer: null };
    room.on(RoomEvent.Disconnected, () => { void closeSession(channelId); });
    armIdle(session);
    return session;
  } catch (err) {
    bot.send({ type: 'bot_voice_leave', channelId });
    await room.disconnect().catch(() => {});
    throw err;
  }
}

function getSession(channelId) {
  let pending = sessions.get(channelId);
  if (!pending) {
    pending = openSession(channelId);
    sessions.set(channelId, pending);
    pending.catch(() => { if (sessions.get(channelId) === pending) sessions.delete(channelId); });
  }
  return pending;
}

async function closeSession(channelId) {
  const pending = sessions.get(channelId);
  if (!pending) return;
  sessions.delete(channelId);
  const session = await pending.catch(() => null);
  if (!session) return;
  clearTimeout(session.timer);
  bot.send({ type: 'bot_voice_leave', channelId });
  await session.room.disconnect().catch(() => {});
}

/** After a reconnect the server has already taken the bot out of every channel: only drop the LiveKit side. */
async function dropAll() {
  const all = [...sessions.values()];
  sessions.clear();
  for (const pending of all) {
    const session = await pending.catch(() => null);
    if (!session) continue;
    clearTimeout(session.timer);
    await session.room.disconnect().catch(() => {});
  }
}

/** Queues one phrase after the ones already waiting in this channel. */
function speak(session, text) {
  const run = async () => {
    clearTimeout(session.timer);
    try {
      const samples = await synthesize(text);
      const pcm = new Int16Array(LEAD.length + samples.length + TAIL.length);
      pcm.set(samples, LEAD.length);
      for (let at = 0; at < pcm.length; at += FRAME) {
        const chunk = new Int16Array(FRAME);
        chunk.set(pcm.subarray(at, at + FRAME));
        await session.source.captureFrame(new AudioFrame(chunk, SAMPLE_RATE, CHANNELS, FRAME));
      }
      await session.source.waitForPlayout();
    } finally {
      armIdle(session);
    }
  };
  session.queue = session.queue.then(run, run);
  return session.queue;
}

bot.run(async (event) => {
  if (event.type === 'ready') {
    await dropAll();
    seats.clear();
    for (const [channelId, userIds] of Object.entries(event.voiceStates ?? {})) {
      for (const userId of userIds) seats.set(userId, channelId);
    }
    await bot.api('PUT', '/bots/@me/commands', { commands });
    return;
  }

  if (event.type === 'voice_state_update') {
    if (event.action === 'join') seats.set(event.userId, event.channelId);
    else if (seats.get(event.userId) === event.channelId) seats.delete(event.userId);
    return;
  }

  if (event.type !== 'interaction_created') return;
  const { id, command, options, user } = event.interaction;
  const answer = (content) => bot.api('POST', `/interactions/${id}/respond`, { content });
  const channelId = seats.get(user.id);

  if (!channelId) {
    await answer(`<@${user.id}> join a voice channel first`);
    return;
  }

  if (command === 'stop') {
    if (!sessions.has(channelId)) {
      await answer(`<@${user.id}> I am not in your channel`);
      return;
    }
    await closeSession(channelId);
    await answer(`<@${user.id}> left your channel`);
    return;
  }

  if (command === 'tts') {
    const text = String(options?.text ?? '').trim().slice(0, MAX_TEXT);
    if (!text) {
      await answer(`<@${user.id}> nothing to say`);
      return;
    }
    try {
      const session = await getSession(channelId);
      await speak(session, text);
      await answer(`<@${user.id}> said it`);
    } catch (err) {
      console.error('tts failed:', err.message);
      await answer(`<@${user.id}> could not speak: ${err.message}`);
    }
  }
});
