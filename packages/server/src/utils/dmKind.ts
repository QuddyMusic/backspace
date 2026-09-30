import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

/**
 * A DM with an owner, or with a random-UUID federated id (36 chars), is a group;
 * a 1-on-1 has no owner and a 32-char hash key (federation.md, "Federated ID Generation").
 */
export function isGroupDmChannel(dmChannelId: string): boolean {
  const row = getDb()
    .select({ ownerId: schema.dmChannels.ownerId, federatedId: schema.dmChannels.federatedId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();
  if (!row) return false;
  return row.ownerId !== null || (row.federatedId !== null && row.federatedId.length === 36);
}
