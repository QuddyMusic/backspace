# Bots

A bot is an ordinary account that a program controls with a token. The server gives a bot exactly what it gives any member (events, REST, permissions) and applies **no behavioural policy of its own**: what a bot answers, when it reacts and whether it needs a mention is decided by the bot's code.

Source files:
- `packages/server/src/routes/bots.ts` -- owner endpoints (create, edit, token, delete, add to a space)
- `packages/server/src/routes/reactions.ts` -- REST reactions, the twin of the WS events
- `packages/server/src/utils/botFederation.ts` -- cutting a bot off from other instances
- `packages/server/src/utils/spaceMembership.ts` -- `addUserToSpace`
- `packages/server/src/utils/auth.ts` -- `tokenFromAuthHeader` (`Bearer` / `Bot`)
- `packages/server/src/routes/auth.ts` -- `POST /api/auth/register` with `botProof`
- `packages/server/src/routes/federation/handlers/attach.ts` -- `verify-attach-proof` answers `isBot`
- `packages/web/src/components/modals/settingsPanels/BotsPanel.tsx` -- Settings > Bots
- `examples/bots/` -- zero-dependency Node clients

---

## 1. Model

- A bot is a `users` row with `is_bot = 1`, `bot_owner_id = <owner id>` and `password_hash = '!bot'` (not a bcrypt hash, so password login is impossible). A bot is native to its instance (`home_instance = NULL`) and `discoverable`.
- **Name.** The username is 5 to 32 characters of `[a-z0-9_]` and always ends with `_bot`. On creation the suffix is appended when missing (`echo` becomes `echo_bot`). The username never changes (it is the federation identity). The owner edits the display name (must also end with `_bot`) and the avatar.
- **Limit.** 10 bots per owner (`bot_limit_reached`).
- **Token.** A JWT (`{userId, username, iat, exp}`, 3650 days), not stored, shown once. Regenerating a token sets `users.password_changed_at`, which revokes every earlier token (`iat` is in whole seconds) and closes the bot's sockets.
- **Owner.** Only a human with an account native to the instance manages bots. A bot, or a federated account, gets `403 bots_native_only`.
- **Deletion.** `DELETE /api/bots/:id` tombstones the bot (DM threads stay readable). Deleting the owner's account tombstones every bot they own.
- The owner's profile rules do not apply to the bot: a bot cannot edit its own durable profile fields through `PATCH /api/users/@me` (`403 bot_profile_owner_only`); the owner does it through `PATCH /api/bots/:id`.

## 2. Authentication
Authorization: Bot <token>

`Bearer <token>` is accepted as an alias everywhere (REST and tus uploads). WebSocket: first message `{"type":"auth","token":"<token>"}`, no scheme.

## 3. Managing bots (owner, JWT of the human)

| Method | Path | Body | Answer |
|--------|------|------|--------|
| GET | `/api/bots` | -- | `{ bots: BotSummary[] }` |
| POST | `/api/bots` | `{ name }` | 201 `{ bot, token }` (5 per 15 min) |
| PATCH | `/api/bots/:id` | `{ displayName?, avatar? }` | `{ bot }` |
| POST | `/api/bots/:id/token` | -- | `{ token, federation }` (5 per 15 min) |
| DELETE | `/api/bots/:id` | -- | `{ success, federation }` |
| GET | `/api/bots/:id/spaces` | -- | `{ spaces: [{ id, name, icon, botIsMember }] }` (spaces where the caller holds MANAGE_SPACE) |
| POST | `/api/bots/:id/spaces` | `{ spaceId }` | `{ success }` |
| DELETE | `/api/bots/:id/spaces/:spaceId` | -- | `{ success }` (MANAGE_SPACE; the bot gets `member_left` and no further events of that space) |

`BotSummary` is `{ id, username, displayName, avatarColor, avatar, createdAt }`. `avatar` is a bare upload filename (upload through tus first) or `null`. Errors use the project format `{ error, code, statusCode, details? }`; the codes specific to bots are `bot_not_found`, `bot_limit_reached`, `bot_name_invalid`, `bot_name_suffix_required`, `bots_native_only`, `bot_profile_owner_only`, `bot_home_not_peered`, `bot_proof_invalid`.

A name change or an avatar change is broadcast (`user_updated`) and relayed to peers as a `profile_update`, so the bot's accounts on other instances follow.

`federation` (token regeneration and deletion) lists, per instance the bot registered on, whether the account there was cut off (see 7).

## 4. Getting a bot into conversations

- **Space, by the owner:** `POST /api/bots/:id/spaces`. The caller needs MANAGE_SPACE in that space; the result is the same as joining (member row, `member_joined`). A banned bot is refused (`user_banned`), a member answers `409 already_member`.
- **Taking the bot out:** `DELETE /api/bots/:id/spaces/:spaceId` by the owner (MANAGE_SPACE), or the ordinary member kick (KICK_MEMBERS) by a space manager. Both end live delivery of that space to the bot's sockets.
- **Space, by the bot:** `POST /api/spaces/join { inviteCode }`, like any user. Request-only spaces answer `403 join_request_required`.
- **Group DM:** any member adds the bot with `POST /api/dm/:id/members { userId }`. The friendship requirement is waived for the **owner adding their own bot**, because bots take no friends.
- **1-on-1 DM:** a user finds the bot with `GET /api/social/search?q=<username>` and opens `POST /api/dm { userId }`. No friendship needed.

A bot holds the permissions of its roles in a space (`@everyone` by default); the space's managers adjust them like for any member.

## 5. What a bot receives and can do

### Events (WebSocket `/ws`)

After `auth` the server answers `{ "type": "ready", "user": { "id", ... }, ... }`; `user.id` is the bot's own id. From then on the bot receives **every event a member of that chat receives**: the list is in [websocket.md](websocket.md) (`message_created`, `message_updated`, `message_deleted`, `reaction_added`, `typing`, `dm_message_created`, `dm_channel_created`, `member_joined`, ...). The server does not filter by mention or by conversation kind.

The bot's own messages come back as events. A bot that answers messages must ignore `message.userId === <own id>` (and DM messages whose `type` is not `user`), or it answers itself.

A mention is the token `<@userId>` in `content`. Code spans and fenced blocks do not count as mentions in the clients; bot code that cares should skip them the same way (`examples/bots/mention-reply.mjs` does).

The socket has no resume. After a reconnect the `ready` payload carries the current state and anything missed is read back with the history endpoints. The server pings every 30 s and drops a dead connection after about 65 s; standard WebSocket clients answer pings themselves.

### Actions (REST)

| Action | Call |
|--------|------|
| Post in a channel | `POST /api/channels/:id/messages { content, attachments?, replyToId? }` |
| Post in a DM | `POST /api/dm/:id/messages { content?, attachments?, replyToId? }` |
| Edit / delete own message | `PATCH` / `DELETE /api/messages/:id` (channel), `PATCH` / `DELETE /api/dm/messages/:id` (DM) |
| React | `PUT /api/messages/:id/reactions/:emoji` (emoji URL-encoded, 1 to 64 characters) |
| Remove own reaction | `DELETE /api/messages/:id/reactions/:emoji` |
| Read history | `GET /api/channels/:id/messages?before=&limit=`, `GET /api/dm/:id/messages?before=&limit=` |
| Upload a file | tus on `/api/files/` (see [uploads.md](uploads.md)), then pass the attachment id in `attachments` |
| Typing indicator | WS `typing_start { channelId }`, `dm_typing_start { dmChannelId }` |

The reaction calls serve channel and DM messages alike (the kind is found by the message id), are idempotent (`{ success: true, changed }`), and use the same code as the WS events `reaction_add` / `reaction_remove`, including the DM relay. The WS events of [websocket.md](websocket.md) remain available for a bot that keeps a socket anyway.

### Limits

Channel messages: 5 per 5 s. Reactions: 10 per 5 s. Both are counted per client address, like every limit in this app ([api.md](api.md), "Rate limiting"). Bot creation and token regeneration: 5 per 15 min per owner.

## 6. Connecting from outside

`https://<instance>` for REST (`/api/...`), `wss://<instance>/ws` for the socket, both behind Caddy. The examples take `BACKSPACE_URL` and `BOT_TOKEN`.

## 7. Bots on other instances

A space lives on one instance and is not relayed, so a bot reaches a space on instance B the way a person does: through a federated account `name@home` on B. The bot's home instance A issues the secret for that account; B asks A whether the account is a bot.

1. On A, with the bot's token: `POST /api/users/@me/federation-credential { origin: "<B origin>" }` returns `secret` (per-remote, never the bot's token).
2. On A: `POST /api/auth/attach-proof { targetDomain: "<bare host of B>" }` returns a one-time `token` (60 s, bound to B).
3. On B: `POST /api/auth/register { username: "x_bot@<A host>", password: <secret>, homeInstance: "<A host>", homeUserId: <bot id on A>, botProof: <token> }`. When the account exists, `POST /api/auth/login` with the same secret.
4. Open `wss://B/ws` with the JWT B returned, join by invite, answer.

B verifies the proof with A over the signed server-to-server channel (`POST /api/federation/verify-attach-proof`, whose signed answer now carries `isBot`) and takes the identity and the bot flag **from that answer**. The body's `username`, `homeUserId` and any `isBot` are ignored, so a client cannot claim to be a bot. A must already be an active peer of B, otherwise `409 bot_home_not_peered` (no handshake is started from an unauthenticated route). A spent or foreign proof answers `401 bot_proof_invalid`.

**Cutting a bot off.** Regenerating the token (mode `soft`), deleting the bot (`full`) and deleting the owner send a signed `DELETE /api/federation/identity` to every instance where the bot holds a credential; the account there is tombstoned and its JWT stops working. After a regeneration the bot registers again with the new token and joins its spaces again. The origins are read before the tombstone, which deletes the credentials.

## 8. Limitations

- An instance without bot support ignores `botProof`: the account there is an ordinary user (no bot flag). A person can also automate a human account without declaring it; the server cannot tell.
- The token is a full user session: a bot can call any REST endpoint a user can. Hashed tokens in their own table, scopes and revocation of a single token are not built.
- `isBot` is not carried by the DM relay: on other instances a DM with a bot shows no bot marker.
- Revocation on another instance depends on the peer: an unreachable or inactive peer leaves the account there until the call is repeated (the answer says which); a bot that owns a space there answers `owns_spaces` and stays.
- A regenerated token removes the bot from its spaces on other instances (the account is recreated).
- The peer of the home instance is found by host without port; two instances on one host and different ports are not supported. `homeInstance` in `register` cannot carry a port.
- When a person replies to a message and mentions a bot, the event carries the replied text in `replyTo`.
- Not built: slash commands and an `interaction` event, per-bot permissions beyond roles, resume after reconnect.

## 9. Database

Migration `0021_familiar_mentor.sql` adds to `users`: `is_bot` (INTEGER NOT NULL DEFAULT 0) and `bot_owner_id` (TEXT, the owner's user id). Nothing else is stored per bot; the avatar and display name are the ordinary `users` columns. The cascade and revocation rules are in 1 and 7.
