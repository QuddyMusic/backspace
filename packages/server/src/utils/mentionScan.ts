/**
 * Scan for `<@id>` mention tokens outside code. The one expression shared by
 * the relay rewrite (federationMentions.ts) and the bot delivery gate
 * (ws/handler.ts); mirrors web/src/utils/mentionTokens.ts.
 */
export function mentionScanner(): RegExp {
  return /(```[\s\S]*?```|`[^`]+`)|<@([a-zA-Z0-9_-]+)>/g;
}

/** The ids of the mention tokens in `content` outside code, once each, in order. */
export function mentionTokenIds(content: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(mentionScanner())) {
    const id = match[2];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
