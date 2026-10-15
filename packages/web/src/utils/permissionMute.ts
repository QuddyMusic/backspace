/**
 * Permission mute ("no SPEAK here") of a voice participant. A person is in one
 * channel at a time, so the server keeps one flag per `spaceId:userId`. A bot
 * can sit in several channels of a space at once and SPEAK is judged per
 * channel, so a bot seat is keyed `spaceId:userId:channelId`. A row in a given
 * channel checks both keys: the bot's mute in another channel does not show.
 */
export function isPermissionMutedIn(
  muted: ReadonlySet<string>,
  spaceId: string | null | undefined,
  userId: string,
  channelId: string | null | undefined,
): boolean {
  if (!spaceId) return false;
  if (muted.has(`${spaceId}:${userId}`)) return true;
  return channelId ? muted.has(`${spaceId}:${userId}:${channelId}`) : false;
}
