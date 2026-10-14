import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { PermissionBits, permissionsToString } from '../utils/permissions.js';

setWorkerId(1);

/**
 * Bot voice seats (`bot_voice_join`) next to person-style seats (`voice_join`):
 * a bot may only take a voice channel, and one channel is never occupied twice
 * by the same bot through the two paths.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const SPACE = 'sp-bot-seats';
const VOICE_A = 'vc-bot-a';
const VOICE_B = 'vc-bot-b';
const TEXT = 'tc-bot';
const BOT = 'bot-1';

function seed(): void {
  const now = Date.now();
  testDb.insert(schema.users).values({
    id: 'owner', username: 'owner', passwordHash: 'x', homeUserId: 'owner', homeInstance: null, createdAt: now,
  }).run();
  testDb.insert(schema.users).values({
    id: BOT, username: 'bot', passwordHash: '!bot', homeUserId: BOT, homeInstance: null, createdAt: now,
    isBot: 1, botOwnerId: 'owner',
  }).run();
  testDb.insert(schema.spaces).values({ id: SPACE, name: 'S', ownerId: 'owner', createdAt: now }).run();
  testDb.insert(schema.roles).values({
    id: SPACE, spaceId: SPACE, name: '@everyone', color: '#b9bbbe', position: 0,
    permissions: permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.CONNECT | PermissionBits.SPEAK),
    createdAt: now,
  }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE, userId: BOT, joinedAt: now }).run();
  for (const [id, type] of [[VOICE_A, 'voice'], [VOICE_B, 'voice'], [TEXT, 'text']] as const) {
    testDb.insert(schema.channels).values({ id, spaceId: SPACE, name: id, type, position: 0, createdAt: now }).run();
  }
}

async function load() {
  const { connectionManager } = await import('./handler.js');
  const { handleClientEvent } = await import('./events.js');
  return { cm: connectionManager, handleClientEvent };
}

const ws = { readyState: 1, send: vi.fn() } as unknown as WebSocket;

beforeEach(() => {
  // connectionManager is a module singleton: a fresh copy per test keeps seats from leaking.
  vi.resetModules();
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bot_voice_join', () => {
  it('refuses a text channel: no seat, an error to the bot', async () => {
    const { cm, handleClientEvent } = await load();
    const sendToUser = vi.spyOn(cm, 'sendToUser');
    handleClientEvent({ type: 'bot_voice_join', channelId: TEXT }, BOT, 'bot', ws, false);
    expect(cm.getBotRoomIds(BOT)).toEqual([]);
    expect(cm.getRoom(TEXT)).toBeFalsy();
    expect(sendToUser).toHaveBeenCalledWith(BOT, expect.objectContaining({ type: 'error', message: 'Target channel is not a voice channel' }));
  });

  it('seats the bot in two voice channels of one space in parallel', async () => {
    const { cm, handleClientEvent } = await load();
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_B }, BOT, 'bot', ws, false);
    expect([...cm.getBotRoomIds(BOT)].sort()).toEqual([VOICE_A, VOICE_B]);
  });

  it('does not take a second seat in a channel the bot holds through voice_join', async () => {
    const { cm, handleClientEvent } = await load();
    handleClientEvent({ type: 'voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    expect(cm.getUserRoom(BOT)?.roomId).toBe(VOICE_A);
    const sendToRoom = vi.spyOn(cm, 'sendToRoom');

    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);

    expect(cm.getBotRoomIds(BOT)).not.toContain(VOICE_A);
    expect(sendToRoom).not.toHaveBeenCalled();
    expect(cm.getUserRoom(BOT)?.roomId).toBe(VOICE_A);
  });
});

describe('voice_join after bot_voice_join', () => {
  it('is a no-op for the channel the bot already sits in', async () => {
    const { cm, handleClientEvent } = await load();
    handleClientEvent({ type: 'bot_voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);
    const sendToRoom = vi.spyOn(cm, 'sendToRoom');

    handleClientEvent({ type: 'voice_join', channelId: VOICE_A }, BOT, 'bot', ws, false);

    expect(cm.getUserRoom(BOT)).toBeNull();
    expect(cm.getBotRoomIds(BOT)).toEqual([VOICE_A]);
    expect(sendToRoom).not.toHaveBeenCalled();
  });
});
