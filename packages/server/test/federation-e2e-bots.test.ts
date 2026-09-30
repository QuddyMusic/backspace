import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  bootTransportPeered,
  readDb,
  waitUntil,
  withWritableDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsCapture } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances, real sockets, real signed S2S calls.
vi.setConfig({ testTimeout: 45_000 });

/**
 * ── e2e: bots across instances ──────────────────────────────────────────────
 *
 * A is the bot's home, B hosts the space. TRANSPORT profile: both identities
 * are the bare host 127.0.0.1 (extractDomain drops the port), the same shape
 * the first-contact suite relies on.
 *
 * Covered: the bot flag on the host comes only from the home's signed proof
 * (a client cannot claim it, a human's proof does not grant it, a proof is
 * single-use, an unpeered home is refused); the mention gate and the history
 * ban apply to that row on the host; a token regeneration on the home
 * tombstones the host account and kills its JWT, and the bot can register anew.
 */

interface ErrBody { code?: string; error?: string }
interface AuthBody extends ErrBody { token: string; user: { id: string; username: string } }
interface BotCreated { bot: { id: string; username: string }; token: string }
interface RegenBody { token: string; federation: Record<string, { success: boolean; error?: string }> }

interface HomeBot { id: string; username: string; token: string }
interface HostBot { id: string; token: string }

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let aHost: string;
let bHost: string;
let owner: TestUser;
let hostHuman: TestUser;
let bot: HomeBot;
let hostBot: HostBot;
let spaceId: string;
let channelId: string;
const sockets: WsCapture[] = [];

async function api<T>(
  inst: SpawnedInstance,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${inst.origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed as T };
}

async function createBot(name: string): Promise<HomeBot> {
  const res = await api<BotCreated>(A, 'POST', '/api/bots', owner.token, { name });
  expect(res.status).toBe(201);
  return { id: res.body.bot.id, username: res.body.bot.username, token: res.body.token };
}

/** A one-time attach proof for B, minted on A by whoever holds `token`. */
async function mintProof(token: string): Promise<string> {
  const res = await api<{ token: string }>(A, 'POST', '/api/auth/attach-proof', token, { targetDomain: bHost });
  expect(res.status).toBe(200);
  return res.body.token;
}

/** The bot's client flow on B: home-issued secret, proof, register. */
async function registerOnHost(homeBot: HomeBot, proofOverride?: string) {
  const cred = await api<{ secret: string }>(A, 'POST', '/api/users/@me/federation-credential', homeBot.token, { origin: B.origin });
  expect(cred.status).toBe(200);
  const proof = proofOverride ?? await mintProof(homeBot.token);
  return api<AuthBody>(B, 'POST', '/api/auth/register', null, {
    username: `${homeBot.username}@${aHost}`,
    password: cred.body.secret,
    homeInstance: aHost,
    homeUserId: homeBot.id,
    botProof: proof,
  });
}

function hostRow(id: string): { isBot: number; homeUserId: string | null; isDeleted: number } | undefined {
  return readDb(B, db => db.prepare(
    'SELECT is_bot AS isBot, home_user_id AS homeUserId, is_deleted AS isDeleted FROM users WHERE id = ?',
  ).get(id) as { isBot: number; homeUserId: string | null; isDeleted: number } | undefined);
}

function delivered(ws: WsCapture, marker: string): boolean {
  return ws.events.some(e =>
    e.type === 'message_created'
    && ((e.message as { content?: string } | undefined)?.content ?? '').includes(marker));
}

beforeAll(async () => {
  h = await bootTransportPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  aHost = new URL(A.origin).hostname;
  bHost = new URL(B.origin).hostname;
  owner = await registerLocal(A, 'owner');
  hostHuman = await registerLocal(B, 'hosthuman');
  bot = await createBot('echo_bot');
}, 120_000);

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await h?.cleanup();
});

describe('the bot flag on a host instance', () => {
  it('a bot registers on the host with a proof from its home and gets is_bot=1', async () => {
    const res = await registerOnHost(bot);
    expect(res.status).toBe(201);
    hostBot = { id: res.body.user.id, token: res.body.token };
    expect(res.body.user.username).toBe(`${bot.username}@${aHost}`);
    expect(hostRow(hostBot.id)).toEqual({ isBot: 1, homeUserId: bot.id, isDeleted: 0 });
  });

  it('a proof is single-use', async () => {
    const other = await createBot('second_bot');
    const cred = await api<{ secret: string }>(A, 'POST', '/api/users/@me/federation-credential', other.token, { origin: B.origin });
    expect(cred.status).toBe(200);
    const proof = await mintProof(other.token);
    const body = {
      username: `${other.username}@${aHost}`,
      password: cred.body.secret,
      homeInstance: aHost,
      homeUserId: other.id,
      botProof: proof,
    };
    const first = await api<AuthBody>(B, 'POST', '/api/auth/register', null, body);
    expect(first.status).toBe(201);
    const replay = await api<ErrBody>(B, 'POST', '/api/auth/register', null, body);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('bot_proof_invalid');
  });

  it('identity comes from the proof, never from the request body', async () => {
    const third = await createBot('third_bot');
    const cred = await api<{ secret: string }>(A, 'POST', '/api/users/@me/federation-credential', third.token, { origin: B.origin });
    // A valid proof for `bot` (already registered on the host) with third_bot's
    // name in the body: the host must act on the proof's identity and refuse.
    const res = await api<ErrBody>(B, 'POST', '/api/auth/register', null, {
      username: `${third.username}@${aHost}`,
      password: cred.body.secret,
      homeInstance: aHost,
      homeUserId: third.id,
      botProof: await mintProof(bot.token),
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('username_taken');
  });

  it("a human's proof does not grant the flag", async () => {
    const humanProof = await mintProof(owner.token);
    const res = await api<AuthBody & ErrBody>(B, 'POST', '/api/auth/register', null, {
      username: `owner@${aHost}`,
      password: 'a-long-enough-password-1',
      homeInstance: aHost,
      homeUserId: owner.id,
      botProof: humanProof,
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('bot_proof_invalid');
  });

  it('a client cannot claim the flag in the request body', async () => {
    const res = await api<AuthBody>(B, 'POST', '/api/auth/register', null, {
      username: `sneaky_bot@${aHost}`,
      password: 'a-long-enough-password-2',
      homeInstance: aHost,
      homeUserId: 'sneaky-home-id',
      isBot: 1,
    });
    expect(res.status).toBe(201);
    expect(hostRow(res.body.user.id)?.isBot).toBe(0);
  });

  it('a home instance that is not an active peer is refused', async () => {
    const res = await api<ErrBody>(B, 'POST', '/api/auth/register', null, {
      username: 'ghost_bot@unpeered.example',
      password: 'a-long-enough-password-3',
      homeInstance: 'unpeered.example',
      homeUserId: 'ghost-id',
      botProof: 'a'.repeat(64),
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('bot_home_not_peered');
  });
});

describe('a bot in a space on the host', () => {
  it('joins by invite and receives the space messages it can view', async () => {
    const created = await api<{ id?: string; inviteCode?: string; space?: { id: string; inviteCode: string } }>(
      B, 'POST', '/api/spaces', hostHuman.token, { name: 'bot-host-space' },
    );
    expect(created.status).toBeLessThan(300);
    const space = created.body.space ?? created.body;
    spaceId = space.id as string;
    const inviteCode = space.inviteCode as string;

    const chRes = await api<Array<{ id: string; type: string }> | { channels: Array<{ id: string; type: string }> }>(
      B, 'GET', `/api/spaces/${spaceId}/channels`, hostHuman.token,
    );
    const channels = Array.isArray(chRes.body) ? chRes.body : chRes.body.channels;
    channelId = (channels.find(c => c.type === 'text') ?? channels[0]!).id;

    const ws = await connectWs(B.origin, hostBot.token);
    sockets.push(ws);
    await ws.waitForEvent('ready');
    expect((await api<ErrBody>(B, 'POST', '/api/spaces/join', hostBot.token, { inviteCode })).status).toBe(200);

    const say = (content: string) =>
      api<unknown>(B, 'POST', `/api/channels/${channelId}/messages`, hostHuman.token, { content });
    await say('plain-marker');
    await say(`<@${hostBot.id}> mention-marker`);
    // What to do with a message is the bot's code's decision, not the server's.
    expect(await waitUntil(() => delivered(ws, 'plain-marker') && delivered(ws, 'mention-marker'), 5_000)).toBe(true);
  });

  it('reads history like any member, and can post', async () => {
    const hist = await api<unknown>(B, 'GET', `/api/channels/${channelId}/messages`, hostBot.token);
    expect(hist.status).toBe(200);
    const post = await api<unknown>(B, 'POST', `/api/channels/${channelId}/messages`, hostBot.token, { content: 'bot-post-marker' });
    expect(post.status).toBe(201);
  });
});

describe('editing a bot on its home', () => {
  it('only the owner can edit, and the input is validated', async () => {
    const stranger = await registerLocal(A, 'stranger');
    const foreign = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, stranger.token, { displayName: 'Hijack' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('bot_not_found');

    const selfEdit = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, bot.token, { displayName: 'Self' });
    expect(selfEdit.status).toBe(403);

    const empty = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, owner.token, { displayName: '   ' });
    expect(empty.status).toBe(400);
    const tooLong = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, owner.token, { displayName: 'x'.repeat(29) + '_bot' });
    for (const bad of ['Echo Prime', '_bot', '   _bot', 'bot_x', 'echo_bot_x']) {
      const r = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, owner.token, { displayName: bad });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('bot_name_suffix_required');
    }
    const selfRename = await api<ErrBody>(A, 'PATCH', '/api/users/@me', bot.token, { displayName: 'renamed' });
    expect(selfRename.status).toBe(403);
    expect(selfRename.body.code).toBe('bot_profile_owner_only');
    expect(tooLong.body.code).toBe('display_name_too_long');
    const badAvatar = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, owner.token, { avatar: '../etc/passwd' });
    expect(badAvatar.body.code).toBe('avatar_url_invalid');
    const nothing = await api<ErrBody>(A, 'PATCH', `/api/bots/${bot.id}`, owner.token, {});
    expect(nothing.body.code).toBe('no_fields_to_update');
  });

  it('a display name change on the home reaches the bot account on the host', async () => {
    const res = await api<{ bot: { username: string; displayName: string | null } }>(
      A, 'PATCH', `/api/bots/${bot.id}`, owner.token, { displayName: 'echo_prime_bot' },
    );
    expect(res.status).toBe(200);
    expect(res.body.bot.displayName).toBe('echo_prime_bot');
    expect(res.body.bot.username).toBe(bot.username);

    const reached = await waitUntil(() => readDb(B, db =>
      (db.prepare('SELECT display_name AS name FROM users WHERE id = ?').get(hostBot.id) as { name: string | null } | undefined)?.name,
    ) === 'echo_prime_bot', 15_000);
    expect(reached).toBe(true);
  });

  it('the _bot suffix is added on creation when missing', async () => {
    const plain = await api<BotCreated>(A, 'POST', '/api/bots', owner.token, { name: 'plainname' });
    expect(plain.status).toBe(201);
    expect(plain.body.bot.username).toBe('plainname_bot');
    const already = await api<BotCreated>(A, 'POST', '/api/bots', owner.token, { name: 'Has_Bot' });
    expect(already.body.bot.username).toBe('has_bot');
    const noStem = await api<ErrBody>(A, 'POST', '/api/bots', owner.token, { name: '_bot' });
    expect(noStem.status).toBe(400);
    expect(noStem.body.code).toBe('bot_name_invalid');
  });
});

describe('bringing a bot into a space by button', () => {
  it('the owner adds their bot to a space they manage, once', async () => {
    const created = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'bot-button-space' });
    expect(created.status).toBeLessThan(300);
    const sid = (created.body.space ?? created.body).id as string;

    const before = await api<{ spaces: Array<{ id: string; botIsMember: boolean }> }>(A, 'GET', `/api/bots/${bot.id}/spaces`, owner.token);
    expect(before.body.spaces.find(s => s.id === sid)?.botIsMember).toBe(false);

    const add = await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, owner.token, { spaceId: sid });
    expect(add.status).toBe(200);
    const again = await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, owner.token, { spaceId: sid });
    expect(again.status).toBe(409);

    const after = await api<{ spaces: Array<{ id: string; botIsMember: boolean }> }>(A, 'GET', `/api/bots/${bot.id}/spaces`, owner.token);
    expect(after.body.spaces.find(s => s.id === sid)?.botIsMember).toBe(true);
  });

  it("someone else's bot, or a space the caller does not manage, is refused", async () => {
    const stranger = await registerLocal(A, 'stranger2');
    const foreign = await api<ErrBody>(A, 'POST', `/api/bots/${bot.id}/spaces`, stranger.token, { spaceId: 'x' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('bot_not_found');

    const strangerBot = await api<BotCreated>(A, 'POST', '/api/bots', stranger.token, { name: 'strangers' });
    const ownSpace = await api<{ id?: string; space?: { id: string } }>(A, 'POST', '/api/spaces', owner.token, { name: 'not-yours' });
    const sid = (ownSpace.body.space ?? ownSpace.body).id as string;
    const noPerm = await api<ErrBody>(A, 'POST', `/api/bots/${strangerBot.body.bot.id}/spaces`, stranger.token, { spaceId: sid });
    expect(noPerm.status).toBe(403);
  });
});

describe('a bot in direct and group conversations on its home', () => {
  let botWs: WsCapture;
  let groupId: string;

  const dmDelivered = (marker: string): boolean =>
    botWs.events.some(e =>
      e.type === 'dm_message_created'
      && ((e.message as { content?: string } | undefined)?.content ?? '').includes(marker));

  it('in a group DM the bot receives every message and can read it', async () => {
    const member = await registerLocal(A, 'groupmate');
    groupId = `e2e-group-${Date.now()}`;
    withWritableDb(A, db => {
      db.prepare('INSERT INTO dm_channels (id, owner_id, federated_id, created_at) VALUES (?, ?, ?, ?)')
        .run(groupId, owner.id, randomUUID(), Date.now());
      const add = db.prepare('INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES (?, ?, 0)');
      for (const uid of [owner.id, bot.id, member.id]) add.run(groupId, uid);
    });
    botWs = await connectWs(A.origin, bot.token);
    sockets.push(botWs);
    await botWs.waitForEvent('ready');

    await api<unknown>(A, 'POST', `/api/dm/${groupId}/messages`, owner.token, { content: 'group-marker' });
    expect(await waitUntil(() => dmDelivered('group-marker'), 5_000)).toBe(true);
    expect((await api<unknown>(A, 'GET', `/api/dm/${groupId}/messages`, bot.token)).status).toBe(200);
  });

  it('in a 1-on-1 DM the bot receives messages and can read them', async () => {
    const dm = await api<{ id?: string; dmChannel?: { id: string } }>(
      A, 'POST', '/api/dm', owner.token, { userId: bot.id },
    );
    expect(dm.status).toBeLessThan(300);
    const dmId = (dm.body.dmChannel?.id ?? dm.body.id) as string;
    await api<unknown>(A, 'POST', `/api/dm/${dmId}/messages`, owner.token, { content: 'one-on-one-marker' });
    expect(await waitUntil(() => dmDelivered('one-on-one-marker'), 5_000)).toBe(true);
    expect((await api<unknown>(A, 'GET', `/api/dm/${dmId}/messages`, bot.token)).status).toBe(200);
  });
});

describe('cutting a bot off from the host', () => {
  it('a token regeneration on the home tombstones the host account and kills its JWT', async () => {
    const oldHomeToken = bot.token;
    // iat is in whole seconds: revocation compares against it.
    await new Promise(r => setTimeout(r, 1_100));

    const regen = await api<RegenBody>(A, 'POST', `/api/bots/${bot.id}/token`, owner.token);
    expect(regen.status).toBe(200);
    const results = Object.values(regen.body.federation);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.success)).toBe(true);
    bot = { ...bot, token: regen.body.token };

    // Home: the old token is revoked, the new one works.
    expect((await api<unknown>(A, 'GET', '/api/spaces', oldHomeToken)).status).toBe(401);
    expect((await api<unknown>(A, 'GET', '/api/spaces', bot.token)).status).toBe(200);

    // Host: the account is tombstoned and its JWT no longer authenticates.
    expect(hostRow(hostBot.id)?.isDeleted).toBe(1);
    expect((await api<unknown>(B, 'GET', '/api/spaces', hostBot.token)).status).toBe(401);
  });

  it('the legitimate bot registers again with its new token', async () => {
    const res = await registerOnHost(bot);
    expect(res.status).toBe(201);
    expect(res.body.user.id).not.toBe(hostBot.id);
    expect(hostRow(res.body.user.id)).toEqual({ isBot: 1, homeUserId: bot.id, isDeleted: 0 });
  });
});
