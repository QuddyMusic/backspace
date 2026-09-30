import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate, signJwt } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { tombstoneUser, collectProfileBroadcastTargetIds } from '../utils/userDeletion.js';
import { deleteUploadFile, deleteAttachmentByFilename } from '../utils/fileCleanup.js';
import { connectionManager } from '../ws/handler.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { BOT_NAME_MAX_LENGTH, BOT_NAME_MIN_LENGTH, BOT_NAME_SUFFIX, MAX_BOTS_PER_USER } from '@backspace/shared/src/constants.js';
import { collectBotFederationOrigins, revokeBotOnPeers } from '../utils/botFederation.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { resizeProfileImage } from '../utils/thumbnail.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { queueProfileUpdateRelay } from '../utils/profileRelay.js';
import type { BotSummary, UpdateBotRequest, UpdateBotResponse } from '@backspace/shared';

/** Not a bcrypt hash, so password login is impossible (same idea as '!federation-replicated'). */
const BOT_PASSWORD_MARKER = '!bot';
/** Bot tokens are JWTs; revocation goes through users.passwordChangedAt. */
const BOT_TOKEN_TTL = '3650d';
const BOT_NAME_RE = /^[a-z0-9_]+$/;
/** A bare upload filename: starts alphanumeric, so `..` and dotfiles cannot pass. */
const AVATAR_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** Same palette as registration (routes/auth.ts). */
const AVATAR_COLORS = ['mint', 'sky', 'lavender', 'coral', 'rose', 'teal', 'amber'] as const;

function toSummary(row: typeof schema.users.$inferSelect): BotSummary {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarColor: row.avatarColor,
    avatar: row.avatar,
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

    if (!username.endsWith(BOT_NAME_SUFFIX)) {
      return sendError(reply, 400, 'bot_name_suffix_required', { suffix: BOT_NAME_SUFFIX });
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
	displayName: username,
	passwordHash: BOT_PASSWORD_MARKER,
	avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
	isBot: 1,
	botOwnerId: request.userId,
	discoverable: 1,
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


    app.patch<{ Params: { id: string }; Body: UpdateBotRequest }>('/api/bots/:id', {
    preHandler: pre,
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const db = getDb();
    const bot = findOwnedBot(request.userId, request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');

    const { displayName, avatar } = request.body ?? {};
    const update: { displayName?: string; avatar?: string | null } = {};

    // The login (username) is deliberately not editable: it is the federation
    // identity peers and host accounts (`name@home`) are keyed on.
    if (displayName !== undefined) {
      const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
      // The suffix marks a bot everywhere its name is shown: it must stay last,
      // with something in front of it.
      if (!trimmed.endsWith(BOT_NAME_SUFFIX) || trimmed.slice(0, -BOT_NAME_SUFFIX.length).trim().length === 0) {
        return sendError(reply, 400, 'bot_name_suffix_required', { suffix: BOT_NAME_SUFFIX });
      }
      if (trimmed.length > BOT_NAME_MAX_LENGTH) {
        return sendError(reply, 400, 'display_name_too_long', { max: BOT_NAME_MAX_LENGTH });
      }
      update.displayName = trimmed;
    }

    let newAvatar: string | null | undefined;
    if (avatar !== undefined) {
      if (avatar === null) {
        newAvatar = null;
      } else if (typeof avatar === 'string') {
        const bare = avatar.startsWith('/api/uploads/') ? avatar.slice('/api/uploads/'.length) : avatar;
        if (!AVATAR_FILE_RE.test(bare) || !fs.existsSync(path.join(config.uploadDir, bare))) {
          return sendError(reply, 400, 'avatar_url_invalid');
        }
        newAvatar = bare;
      } else {
        return sendError(reply, 400, 'avatar_url_invalid');
      }
      update.avatar = newAvatar;
    }

    if (Object.keys(update).length === 0) {
      return sendError(reply, 400, 'no_fields_to_update');
    }

    // Monotonic: a receiver ignores a profile version that is not newer.
    const profileUpdatedAt = Math.max(Date.now(), (bot.profileUpdatedAt ?? 0) + 1);
    db.update(schema.users).set({ ...update, profileUpdatedAt }).where(eq(schema.users.id, bot.id)).run();

    if (newAvatar !== undefined && bot.avatar && bot.avatar !== newAvatar && !bot.avatar.startsWith('http')) {
      await deleteUploadFile(bot.avatar);
      deleteAttachmentByFilename(bot.avatar);
    }
    if (typeof newAvatar === 'string') {
      // The upload's attachment record is redundant once users.avatar holds it
      // (same handling as PATCH /users/@me).
      if (typeof avatar === 'string' && avatar.includes('/api/uploads/')) deleteAttachmentByFilename(avatar);
      await resizeProfileImage(path.join(config.uploadDir, newAvatar), 'avatar');
    }

    const updated = db.select().from(schema.users).where(eq(schema.users.id, bot.id)).get();
    if (!updated) return sendError(reply, 500, 'internal_error');

    const targets = collectProfileBroadcastTargetIds(bot.id);
    targets.add(bot.id);
    for (const uid of targets) {
      connectionManager.sendToUser(uid, { type: 'user_updated' as const, user: sanitizeUser(updated, uid === bot.id) });
    }
    queueProfileUpdateRelay(updated);

    const response: UpdateBotResponse = { bot: toSummary(updated) };
    return reply.send(response);
  });

  app.post<{ Params: { id: string } }>('/api/bots/:id/token', {
    preHandler: pre,
    config: rateLimit,
  }, async (request, reply) => {
    const bot = findOwnedBot(request.userId, request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');
        // Cut the bot off from every instance it registered on FIRST: a leaked
    	// token could already have minted host JWTs there, and those outlive the
    	// home token. The host account is tombstoned; the legitimate bot
    	// re-registers with the new token and rejoins by invite.
    	const origins = collectBotFederationOrigins(bot.id);
    	const federation = await revokeBotOnPeers(bot.id, origins, 'soft');
    	getDb().delete(schema.userFederationCredentials)
      	  .where(eq(schema.userFederationCredentials.userId, bot.id)).run();
    	// Revokes every earlier token: same mechanism as a password change.
    	getDb().update(schema.users).set({ passwordChangedAt: Date.now() })
      	  .where(eq(schema.users.id, bot.id)).run();
    	connectionManager.forceDisconnectUser(bot.id);
    	const token = signJwt({ userId: bot.id, username: bot.username }, { expiresIn: BOT_TOKEN_TTL });
    	return reply.send({ token, federation });
  });

  app.delete<{ Params: { id: string } }>('/api/bots/:id', {
    preHandler: pre,
  }, async (request, reply) => {
    const bot = findOwnedBot(request.userId, request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');
    const origins = collectBotFederationOrigins(bot.id);
    const federation = await revokeBotOnPeers(bot.id, origins, 'full');
    const files = tombstoneUser(bot.id);
    connectionManager.forceDisconnectUser(bot.id);
    for (const filename of files) await deleteUploadFile(filename);
    return reply.send({ success: true, federation });
  });
}
