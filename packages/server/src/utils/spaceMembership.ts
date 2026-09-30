import { eq } from 'drizzle-orm';
import type { MemberWithUser } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { connectionManager } from '../ws/handler.js';
import { sanitizeUser } from './sanitize.js';

/**
 * Adds a user to a space: the member row, the live WS registration and the
 * `member_joined` broadcast. Callers must have checked bans, duplicates and
 * the visibility/permission rules for their entry path.
 */
export function addUserToSpace(spaceId: string, userId: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(schema.spaceMembers).values({ spaceId, userId, joinedAt: now }).run();

  // Register the user so a connected session receives this space's broadcasts.
  connectionManager.addUserSpace(userId, spaceId);

  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return;
  const member: MemberWithUser = {
    spaceId,
    userId,
    nickname: null,
    joinedAt: now,
    user: sanitizeUser(user),
    roles: [],
  };
  connectionManager.sendToSpace(spaceId, { type: 'member_joined', spaceId, member });
}
