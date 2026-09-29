import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate, signJwt } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { tombstoneUser } from '../utils/userDeletion.js';
import { deleteUploadFile } from '../utils/fileCleanup.js';
import { connectionManager } from '../ws/handler.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { BOT_NAME_MAX_LENGTH, BOT_NAME_MIN_LENGTH, MAX_BOTS_PER_USER } from '@backspace/shared/src/constants.js';
import type { BotSummary } from '@backspace/shared';

/** Not a bcrypt hash, so password login is impossible (same idea as '!federation-replicated'). */
const BOT_PASSWORD_MARKER = '!bot';
/** Bot tokens are JWTs; revocation goes through users.passwordChangedAt. */
const BOT_TOKEN_TTL = '3650d';
const BOT_NAME_RE = /^[a-z0-9_]+$/;
/** Same palette as registration (routes/auth.ts). */
const AVATAR_COLORS = ['mint', 'sky', 'lavender', 'coral', 'rose', 'teal', 'amber'] as const;

function toSummary(row: typeof schema.users.$inferSelect): BotSummary {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarColor: row.avatarColor,
    createdAt: row.createdAt,
  };
}

function findOwnedBot(ownerId: string, botId: string) {
  return getDb().select().from(schema.users).where(and(
    eq(schema.users.id, botId),
    eq(schema.users.botOwnerId, ownerId),
    eq(schema.users.isBot, 1),
    eq(schema.users.isDeleted, 0),
  )).get();
}

/**
 * Bot management for the owning human. Bots are ordinary `users` rows with
 * `is_bot = 1`; they authenticate with a long-lived JWT issued here.
 */
export async function botRoutes(app: FastifyInstance): Promise<void> {
  // Only a human with an account native to this instance manages bots.
  const requireNativeHuman = async (request: FastifyRequest, reply: FastifyReply) => {
    const caller = getDb().select({ isBot: schema.users.isBot })
      .from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!caller || caller.isBot === 1 || request.homeInstance) {
      return sendError(reply, 403, 'bots_native_only');
    }
  };
  const pre = [authenticate, requireNativeHuman];
  const rateLimit = { rateLimit: { max: 5, timeWindow: '15 minutes' } };

  app.get('/api/bots', { preHandler: pre }, async (request, reply) => {
    const rows = getDb().select().from(schema.users).where(and(
      eq(schema.users.botOwnerId, request.userId),
      eq(schema.users.isBot, 1),
      eq(schema.users.isDeleted, 0),
    )).orderBy(schema.users.createdAt).all();
    return reply.send({ bots: rows.map(toSummary) });
  });

  app.post<{ Body: { name?: unknown } }>('/api/bots', {
    preHandler: pre,
    config: rateLimit,
  }, async (request, reply) => {
    const db = getDb();
    const raw = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    const username = raw.toLowerCase();
    if (username.length < BOT_NAME_MIN_LENGTH || username.length > BOT_NAME_MAX_LENGTH || !BOT_NAME_RE.test(username)) {
      return sendError(reply, 400, 'bot_name_invalid', { min: BOT_NAME_MIN_LENGTH, max: BOT_NAME_MAX_LENGTH });
    }

    const owned = db.select({ n: sql<number>`count(*)` }).from(schema.users).where(and(
      eq(schema.users.botOwnerId, request.userId),
      eq(schema.users.isBot, 1),
      eq(schema.users.isDeleted, 0),
    )).get();
    if ((owned?.n ?? 0) >= MAX_BOTS_PER_USER) {
      return sendError(reply, 400, 'bot_limit_reached', { max: MAX_BOTS_PER_USER });
    }

    const id = generateSnowflake();
    try {
      db.insert(schema.users).values({
        id,
        username,
        displayName: raw,
        passwordHash: BOT_PASSWORD_MARKER,
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
        isBot: 1,
        botOwnerId: request.userId,
        createdAt: Date.now(),
      }).run();
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        return sendError(reply, 409, 'username_taken');
      }
      throw err;
    }

    const bot = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!bot) return sendError(reply, 500, 'internal_error');
    const token = signJwt({ userId: id, username }, { expiresIn: BOT_TOKEN_TTL });
    return reply.code(201).send({ bot: toSummary(bot), token });
  });

  app.post<{ Params: { id: string } }>('/api/bots/:id/token', {
    preHandler: pre,
    config: rateLimit,
  }, async (request, reply) => {
    const bot = findOwnedBot(request.userId, request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');
    // Revokes every earlier token: same mechanism as a password change.
    getDb().update(schema.users).set({ passwordChangedAt: Date.now() })
      .where(eq(schema.users.id, bot.id)).run();
    connectionManager.forceDisconnectUser(bot.id);
    const token = signJwt({ userId: bot.id, username: bot.username }, { expiresIn: BOT_TOKEN_TTL });
    return reply.send({ token });
  });

  app.delete<{ Params: { id: string } }>('/api/bots/:id', {
    preHandler: pre,
  }, async (request, reply) => {
    const bot = findOwnedBot(request.userId, request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');
    const files = tombstoneUser(bot.id);
    connectionManager.forceDisconnectUser(bot.id);
    for (const filename of files) await deleteUploadFile(filename);
    return reply.send({ success: true });
  });
}
