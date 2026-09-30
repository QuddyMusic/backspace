import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { sendError } from './httpErrors.js';
import { isGroupDmChannel } from './dmKind.js';

/** preHandler: bots work from WS events only; history/search of spaces is closed to them. */
export async function denyBots(request: FastifyRequest, reply: FastifyReply) {
  const row = getDb().select({ isBot: schema.users.isBot })
    .from(schema.users).where(eq(schema.users.id, request.userId)).get();
  if (row?.isBot === 1) return sendError(reply, 403, 'bot_forbidden');
}

export async function denyBotsInGroupDm(request: FastifyRequest, reply: FastifyReply) {
  const row = getDb().select({ isBot: schema.users.isBot })
    .from(schema.users).where(eq(schema.users.id, request.userId)).get();
  if (row?.isBot !== 1) return;
  const { id } = request.params as { id: string };
  if (isGroupDmChannel(id)) return sendError(reply, 403, 'bot_forbidden');
}
