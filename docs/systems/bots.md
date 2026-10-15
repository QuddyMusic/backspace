# Bots

A bot is an ordinary account that a program controls with a token. The server gives a bot exactly what it gives any member (events, REST, permissions) and applies **no behavioural policy of its own**: what a bot answers, when it reacts and whether it needs a mention is decided by the bot's code.

Source files:
- `packages/server/src/routes/bots.ts` -- owner endpoints (create, edit, token, delete, add to a space)
- `packages/server/src/routes/reactions.ts` -- REST reactions, the twin of the WS events
- `packages/server/src/utils/botFederation.ts` -- cutting a bot off from other instances
- `packages/server/src/utils/spaceMembership.ts` -- `addUserToSpace`, `removeUserFromSpace`
- `packages/server/src/utils/auth.ts` -- `tokenFromAuthHeader` (`Bearer` / `Bot`), `verifyAccessToken` (session JWT or `bsb_` bot token)
- `packages/server/src/utils/botTokens.ts` -- issue, verify, list and revoke `bsb_` tokens
- `packages/server/src/routes/auth.ts` -- `POST /api/auth/register` with `botProof`
- `packages/server/src/routes/federation/handlers/attach.ts` -- `verify-attach-proof` answers `isBot`
- `packages/web/src/components/modals/settingsPanels/BotsPanel.tsx` -- Settings > Bots, shown only while Settings > Developer > Developer Mode is on (`stores/developerModeStore.ts` mirrors `users.developer_mode`, stored with the account so every device agrees and written through `PATCH /api/users/@me { developerMode }`; it only shows or hides the tab and does not restrict the API)
- `packages/server/src/routes/botCommands.ts`, `routes/interactions.ts`, `utils/botAuth.ts` -- slash commands
- `packages/server/src/ws/handler.ts`, `ws/events.ts` -- bot voice seats (`botJoinRoom`, `bot_voice_join`)
- `packages/web/src/components/chat/CommandPopover.tsx` -- the command lists in the message box
- `examples/bots/` -- zero-dependency Node clients

---

## 1. Model

- A bot is a `users` row with `is_bot = 1`, `bot_owner_id = <owner id>` and `password_hash = '!bot'` (not a bcrypt hash, so password login is impossible). A bot is native to its instance (`home_instance = NULL`) and `discoverable`.
- **Name.** The username is 5 to 32 characters of `[a-z0-9_]` and always ends with `_bot`. On creation the suffix is appended when missing (`echo` becomes `echo_bot`). The username never changes (it is the federation identity). The owner edits the display name (must also end with `_bot`) and the avatar.
- **Limit.** 10 bots per owner (`bot_limit_reached`).
- **Token.** `bsb_<id>.<secret>`: `id` is 16 hex characters, `secret` is 32 random bytes in base64url (43 characters). The secret is shown once; only its SHA-256 is stored (`bot_tokens`), so a database leak does not leak working tokens, and a leaked token is recognisable by its `bsb_` prefix. A bot holds up to 5 tokens (`bot_token_limit_reached`), each with an optional label of 1 to 32 characters, and the owner revokes each on its own. `last_used_at` is written at most once a minute per token. `POST /api/bots/:id/token` is the full cut-off: it revokes every token, sets `users.password_changed_at` (which also kills any old JWT), cuts the bot off on other instances (see 7), closes the bot's sockets and issues one new token. See "Token migration" (8b).
- **Owner.** Only a human with an account native to the instance manages bots. A bot, or a federated account, gets `403 bots_native_only`.
- **Deletion.** `DELETE /api/bots/:id` tombstones the bot (DM threads stay readable). Deleting the owner's account tombstones every bot they own.
- The owner's profile rules do not apply to the bot: a bot cannot edit its own durable profile fields through `PATCH /api/users/@me` (`403 bot_profile_owner_only`); the owner does it through `PATCH /api/bots/:id`.

## 2. Authentication

```
Authorization: Bot <token>
```

`Bearer <token>` is accepted as an alias everywhere (REST and tus uploads). WebSocket: first message `{"type":"auth","token":"<token>"}`, no scheme.

## 3. Managing bots (owner, JWT of the human)

| Method | Path | Body | Answer |
|--------|------|------|--------|
| GET | `/api/bots` | -- | `{ bots: BotSummary[] }` |
| POST | `/api/bots` | `{ name }` | 201 `{ bot, token }` (5 per 15 min); the token is the bot's first `bsb_` token |
| PATCH | `/api/bots/:id` | `{ displayName?, avatar? }` | `{ bot }` (`avatar`: a bare filename of the owner's own upload that no message holds, or the current avatar, or `null`; anything else is `avatar_url_invalid`) |
| POST | `/api/bots/:id/token` | -- | `{ token, federation }` (5 per 15 min): revokes all tokens, cuts the bot off on other instances, issues one new token |
| GET | `/api/bots/:id/tokens` | -- | `{ tokens: BotTokenSummary[], legacy }` (30 per 15 min; no secrets; `legacy` is true while the bot still runs on its old JWT and holds no token) |
| POST | `/api/bots/:id/tokens` | `{ name? }` | 201 `{ id, name, createdAt, lastUsedAt, token }` (5 per 15 min; 400 `bot_token_name_invalid` / `bot_token_limit_reached`) |
| DELETE | `/api/bots/:id/tokens/:tokenId` | -- | `{ success }` (30 per 15 min; 404 `bot_token_not_found`) |
| DELETE | `/api/bots/:id` | -- | `{ success, federation }` |
| GET | `/api/bots/search?q=` | -- | `{ bots: BotSearchResult[] }` (native discoverable bots, username substring of 2-32 characters, up to 25; any signed-in account; each result adds `ownerUsername`, `null` when the owner is deleted or not discoverable) |
| GET | `/api/bots/:id/spaces` | -- | `{ spaces: [{ id, name, icon, botIsMember }] }` (owner; the caller's MANAGE_SPACE spaces plus every space the bot already sits in) |
| POST | `/api/bots/:id/spaces` | `{ spaceId }` | `{ success }` (any native bot of this instance; MANAGE_SPACE in the space) |
| DELETE | `/api/bots/:id/spaces/:spaceId` | -- | `{ success }` (the bot's owner, or MANAGE_SPACE in the space; the bot gets `member_left` and no further events of that space; its role assignments and per-member channel overrides in that space are deleted too, whichever path removed it: this route, a kick or a ban) |

`BotSummary` is `{ id, username, displayName, avatarColor, avatar, createdAt }`. `avatar` is a bare upload filename (upload through tus first) or `null`. Errors use the project format `{ error, code, statusCode, details? }`; the codes specific to bots are `bot_not_found`, `bot_limit_reached`, `bot_name_invalid`, `bot_name_suffix_required`, `bots_native_only`, `bot_profile_owner_only`, `bot_home_not_peered`, `bot_proof_invalid`, `bot_account_required`, `bots_no_friends`, `bot_token_limit_reached`, `bot_token_not_found`, `bot_token_name_invalid`.

`BotTokenSummary` is `{ id, name, createdAt, lastUsedAt }`; `lastUsedAt` is `null` while the token was never used. Revoking one token (or adding the first one to a legacy bot) closes the bot's sockets, so a connection that authenticated with the revoked token ends at once; the other tokens reconnect. A single revoke does not touch the bot's accounts on other instances: those hold their own credentials, and only `POST /api/bots/:id/token` and deleting the bot cut them off.

A name change or an avatar change is broadcast (`user_updated`) and relayed to peers as a `profile_update`, so the bot's accounts on other instances follow.

`federation` (token regeneration and deletion) lists, per instance the bot registered on, whether the account there was cut off (see 7).

## 4. Getting a bot into conversations

- **Space, by a manager:** `POST /api/bots/:id/spaces`. Any native human with MANAGE_SPACE in the space may add any native bot of this instance — their own or someone else's. The bot's owner takes no part and is not asked; they see every space of their bot in `GET /api/bots/:id/spaces` (their manageable spaces plus every space the bot already sits in) and can end the membership themselves. A federated bot account or a human as the target answers `404 bot_not_found`. The result is the same as joining (member row, `member_joined`). A banned bot is refused (`user_banned`), a member answers `409 already_member`. A federated human account with MANAGE_SPACE may also invite and remove bots, because both are actions on the space. Creating, editing, re-issuing the token of and deleting a bot stay with the native owner account on the bot's home instance, where the bot's row and signing key live. Managing a bot from another instance would need a separate server-to-server design, and while the home instance is down its tokens cannot be re-issued anywhere.
- **Finding a bot to invite:** `GET /api/bots/search?q=<substring>` — native, discoverable bots of this instance by username substring (2-32 characters; `%` and `_` are literal; any other length answers an empty list), up to 25, ordered by username. The caller's own bots are listed too: a directory, not a policy. Each result names its owner (`ownerUsername`), so a manager sees whose code they are inviting. The web client offers the flow in Space settings → Members → "Add Bot".
- **Taking the bot out:** `DELETE /api/bots/:id/spaces/:spaceId` — by the bot's owner (any space of their bot) or by a space manager (MANAGE_SPACE); the ordinary member kick (KICK_MEMBERS) keeps working as before. Kick, ban and both removal routes end live delivery of that space to the bot's sockets at once and take the bot out of that space's voice channels.
- **Space, by the bot:** `POST /api/spaces/join { inviteCode }`, like any user. Request-only spaces answer `403 join_request_required`.
- **Group DM:** any member adds the bot with `POST /api/dm/:id/members { userId }`. The friendship requirement is waived for the **owner adding their own bot**, because bots take no friends.
- **1-on-1 DM:** a user finds the bot with `GET /api/social/search?q=<username>` and opens `POST /api/dm { userId }`. No friendship needed.

A bot holds the permissions of its roles in a space (`@everyone` by default); the space's managers adjust them like for any member.

## 5. What a bot receives and can do

### Events (WebSocket `/ws`)

After `auth` the server answers `{ "type": "ready", "user": { "id", ... }, ... }`; `user.id` is the bot's own id. From then on the bot receives **every event a member of that chat receives**: the list is in [websocket.md](websocket.md) (`message_created`, `message_updated`, `message_deleted`, `reaction_added`, `typing`, `dm_message_created`, `dm_channel_created`, `member_joined`, ...). The server does not filter by mention or by conversation kind.

The bot's own messages come back as events. A bot that answers messages must ignore `message.userId === <own id>` (and DM messages whose `type` is not `user`), or it answers itself.

Messages of other bots arrive as well (`message.user.isBot`). Two bots that answer every message answer each other without end; the examples ignore bots. A bot cannot invoke slash commands (`403 bots_cannot_invoke_commands`), its own or another bot's: a command is something a person asks of a bot.

A mention is the token `<@userId>` in `content`. Code spans and fenced blocks do not count as mentions in the clients; bot code that cares should skip them the same way (`examples/bots/mention-reply.mjs` does).

The socket has no resume. After a reconnect the `ready` payload carries the current state and anything missed is read back with the history endpoints. The server pings every 30 s and drops a dead connection after about 65 s; standard WebSocket clients answer pings themselves.

### One process per token

A bot runs as one process that serves all of its channels: one credential holds **one** open socket. A second `auth` with a credential whose socket is still open gets `{ "type": "error", "code": "bot_token_in_use" }` and is closed with code **4409** (`BOT_TOKEN_IN_USE_CLOSE_CODE` in `shared/constants.ts`); the first socket, its events and its voice seats are untouched. The credential is a `bsb_` token (each of the up to 5 tokens is its own credential), or for a JWT login of a bot account (a pre-`bsb_` JWT, or a bot's federated account on another instance) the account itself. A socket that is closing or closed does not hold its credential, so a restarted process connects at once; after a network drop the old socket can hold it until the heartbeat drops it (about 65 s), so a refused client retries (`examples/bots/client.mjs` waits 30 s). REST calls are not limited this way. The holder is kept in `ConnectionManager` (`claimBotSession` / `releaseBotSession`, released in `removeConnection`).

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

Messages in channels and in DMs: 5 per 5 s each. Reactions: 10 per 5 s. Both are counted per client address, like every limit in this app ([api.md](api.md), "Rate limiting"). Bot creation, token regeneration and token creation: 5 per 15 min, also counted per client address.

## 5b. Slash commands

A bot registers commands for itself. A person picks one in the message box (typing `/` opens the list), the server checks the call and hands it to the bot as an event, and the bot answers with ordinary messages. What a command does is the bot's code; the server only carries the call.

### Registering

```
PUT /api/bots/@me/commands   { commands: [ { name, description, options?: [ { name, description, type, required?, choices? } ] } ] }
GET /api/bots/@me/commands   → { commands: BotCommand[] }
```

Bot token only (`403 bot_account_required` for anyone else). `PUT` replaces the whole list in one call, so repeating it is harmless; a command that keeps its name keeps its id. 10 calls per 5 minutes.

Rules: command and option names are 1 to 32 characters of `a-z 0-9 _ -` and unique; descriptions are 1 to 100 characters; at most 100 commands and 10 options per command; option types are `string`, `integer` (a safe integer), `number` and `boolean`; required options come before optional ones; a `string`, `integer` or `number` option may list up to 25 `choices` (`{ name, value }`, the value of the option's type, unique). A violation answers `400 validation_failed` and `details.field` names the field, for example `commands[0].options[1].name`.

Commands are stored on the instance the bot registers them on: register them on every instance where the bot has an account.

### Invoking

```
GET  /api/commands?channelId=<id>  |  ?dmChannelId=<id>   → { commands: [ { id, botId, name, description, options, updatedAt, bot: { id, username, displayName, avatar, avatarColor } } ] }
POST /api/interactions   { botId, command, options?, channelId | dmChannelId }   → 201 { id, expiresAt }
```

`GET` lists the commands of the bots that are in that chat; the caller must be able to see it. `POST` checks, in this order: exactly one of `channelId` and `dmChannelId`; the caller is a member and may write there (SEND_MESSAGES in a channel); the bot is in the chat (`404 bot_not_found`); the command exists (`404 command_not_found`); each option value fits its definition, including `choices` (`400 validation_failed`, `details.field` is `options.<name>`); the bot has an open WebSocket (`409 bot_unavailable`). 5 calls per 5 seconds per client address.

Command names are unique per bot, not per chat: two bots may both offer `/play`. Every listing entry names its bot, and an invocation names it too (`botId`), so a clash reaches exactly the bot it addresses; the message box shows the bot's `@username` under each command. A command typed out by hand, without picking a row from the list, runs the first of the clashing commands in the listing's order (name, then the bot's username).

### The event

```json
{ "type": "interaction_created",
  "interaction": { "id": "...", "command": "play", "options": { "query": "song", "volume": 80 },
                   "user": { "id": "...", "username": "..." },
                   "channelId": "...", "spaceId": "...", "expiresAt": 1790000000000 } }
```

`options` holds the parsed values with the types of the definition; an optional option that was not given is absent. A call from a space channel carries `channelId` and `spaceId`, a call from a direct or group DM carries `dmChannelId`. `user` is the person who invoked the command.

### Answering

```
POST /api/interactions/:id/respond   { content?, attachments? }   → 201 (the created message)
```

Bot token only, and only the invoked bot. The message is posted through the same route as `POST /channels/:id/messages` or `POST /dm/:id/messages`, so permissions, the length limit, attachments, embeds and the rate limit are the ordinary ones. The interaction lasts 15 minutes and takes up to 5 responses. Errors: `404 interaction_not_found` (also for another bot's interaction), `410 interaction_expired`, `429 interaction_responses_exceeded`, and whatever the message route answers. The message is the bot's own; mention the invoker with `<@user.id>` if the answer is for them. A bot that never answers causes nothing more than silence until the interaction expires.

### In the message box

Typing `/` at the start of a message lists the commands of the bots in the chat. Choosing one writes it with its required options as `name:` ready to be filled in; after a space the optional options not used yet are offered (Tab picks one); pasting a full command works too. The form is: options first as `name:value` (several words in double quotes), then the rest of the line, which is the value of the last string option and may be any length: `/play volume:80 any long title`. The server only ever sees the parsed `options`.

The list is fetched again at the start of every new command (the text goes from not starting with `/` to starting with it), so a bot that registered, changed or lost commands, or joined or left the chat, shows up the next time a command is typed; the old list stays visible until the answer arrives. Enter while a command is being invoked does nothing: the composer is cleared as the request leaves and gets the text back if the invocation fails.

### Scope

Chats on the instance where the bot is connected. Not built: subcommands, autocomplete, private (visible to one person) answers (a bot may message the invoker directly), buttons and forms, `user` and `channel` option types, commands of bots from other instances in direct messages.

## 5c. Voice channels

A person has one voice seat at a time. A bot may sit in several voice channels at once, one seat per channel, so a radio bot never has to be shared between channels. Each voice channel is its own LiveKit room, so the audio of the seats is independent.

### Client events (WebSocket, bots only)

| type | fields | notes |
|------|--------|-------|
| `bot_voice_join` | channelId | seats the bot in that voice channel without leaving the others |
| `bot_voice_leave` | channelId | takes the bot out of that one channel |

`bot_voice_join` makes the same checks as `voice_join` (the channel exists and is a voice channel, otherwise `Target channel is not a voice channel`; the bot is a member of the space; CONNECT) and is idempotent. One channel is never occupied twice by the same bot: `bot_voice_join` into the channel where the bot already holds its ordinary `voice_join` seat does nothing, and `voice_join` into a channel where it holds a bot seat does nothing. A bot may hold at most 25 seats. A refusal arrives as an `error` event; a person sending these events gets `code: 'bot_account_required'`. Space voice channels only: DM calls keep their rules. Voice moderation (space mute and deafen) does not reach a seat taken with `bot_voice_join`; a bot that joined with the ordinary `voice_join` is moderated like a person, and such a restriction is not applied to its later bot seats.

The rest of the space sees the bot like anyone else: `voice_state_update { action: 'join' | 'leave' }` per channel, and the `ready` payload lists the bot under `voiceStates` of every channel it sits in.

### Audio

For each channel the bot asks for a token of its own and connects to that room itself:

```
POST /api/livekit/token   { channelId }   → { token, url }
```

The call works for a bot exactly as for a person (a role without SPEAK or STREAM limits what the token may publish). One LiveKit connection per room, publishing one audio track each, is how a bot plays different audio in different channels; the track is produced by the bot's own code with a LiveKit client library, which the server neither provides nor needs. Which channel a command belongs to is the bot's decision as well: the interaction names the invoker, and `voice_state_update` and the `ready` payload say in which voice channel that person sits (`examples/bots/voice.mjs`).

**SPEAK and mute.** Whether a bot may speak is judged per channel (a role or channel override without SPEAK). A seat in such a channel is shown as muted there and only there: the bot's seats in other channels, also of the same space, keep their own state. `voice_permission_muted` carries the `channelId` of the seat. A listener's own "Mute User" and volume slider are kept per seat for a bot too (voice.md, 4), so muting the bot in one channel does not mute it in the others. The track the bot publishes is limited by its LiveKit token as for a person. A moderator mutes, deafens or disconnects one seat of a bot: the context menu of the bot in a channel sends `voice_space_mute` / `voice_space_deafen` / `voice_disconnect` with that `channelId`; the bit is checked in that channel. The mute and deafen are kept per channel (`bot_seat_restrictions`), come back when the bot takes the seat again, and are shown like a person's moderator mute, in that channel only; the bot gets `voice_space_muted` / `voice_space_deafened` with `botSeat: true` and is expected to stop publishing (or listening) there, as a person's client does (`examples/bots/voice.mjs`). A disconnect ends that seat only (`voice_disconnected` with its `channelId`). Bots are not moved between channels.

### When a seat ends

The bot leaves a seat with `bot_voice_leave`. All its seats end 5 seconds after its socket closes (a bot holds one socket per token, see "One process per token"), and at once when its token is regenerated or revoked or the account deleted, and the seats of one space end when the bot is removed from that space, kicked or banned.

### Limits

`voice_status` (mute, camera, screen share) is not wired for bot seats, and the voice moderation actions (move, disconnect, space mute) do not act on them; a moderator takes a bot out of its channels by removing it from the space.

## 6. Connecting from outside

`https://<instance>` for REST (`/api/...`), `wss://<instance>/ws` for the socket, both behind Caddy. The examples take `BACKSPACE_URL` and `BOT_TOKEN`.

## 7. Bots on other instances

A space lives on one instance and is not relayed, so a bot reaches a space on instance B the way a person does: through a federated account `name@home` on B. The bot's home instance A issues the secret for that account; B asks A whether the account is a bot.

1. On A, with the bot's token: `POST /api/users/@me/federation-credential { origin: "<B origin>" }` returns `secret` (per-remote, never the bot's token).
2. On A: `POST /api/auth/attach-proof { targetDomain: "<bare host of B>" }` returns a one-time `token` (60 s, bound to B).
3. On B: `POST /api/auth/register { username: "x_bot@<A host>", password: <secret>, homeInstance: "<A host>", homeUserId: <bot id on A>, botProof: <token> }`. When the account exists, `POST /api/auth/login` with the same secret.
4. Open `wss://B/ws` with the JWT B returned, join by invite, answer.

B verifies the proof with A over the signed server-to-server channel (`POST /api/federation/verify-attach-proof`, whose signed answer now carries `isBot`) and takes the identity and the bot flag **from that answer**. The body's `username`, `homeUserId` and any `isBot` are ignored, so a client cannot claim to be a bot. A must already be an active peer of B, otherwise `409 bot_home_not_peered` (no handshake is started from an unauthenticated route). A spent, foreign or non-bot proof answers `401 bot_proof_invalid`; a malformed one answers `400`.

**Cutting a bot off.** Regenerating the token (mode `soft`), deleting the bot (`full`) and deleting the owner send a signed `DELETE /api/federation/identity` to every instance where the bot holds a credential; the account there is tombstoned and its JWT stops working. After a regeneration the bot registers again with the new token and joins its spaces again. The origins are read before the tombstone, which deletes the credentials.

## 8. Limitations

- An instance without bot support ignores `botProof`: the account there is an ordinary user (no bot flag). A person can also automate a human account without declaring it; the server cannot tell.
- A token is a full user session: a bot can call any REST endpoint a user can. Scopes (a token limited to some endpoints or spaces) are not built.
- On other instances a bot's row takes the bot flag from its home: the home's answer when the row is created (`/users/by-home-id`) and the participant snapshots of a DM the home relays (federation.md, "Bot flag"). A row created before an instance knew this gets it with the next DM message the bot's home relays.
- Revocation on another instance depends on the peer. Per origin, `federation` answers `{ success: true }`, `{ success: false, error, pending: true }` (the instance is away, not peered at the moment or answered 5xx/401/408/429: the server keeps trying, see "Revocation retries" below) or `{ success: false, error, pending: false }` (the instance refused: a bot that owns a space there answers `owns_spaces` and stays; a 403 attribution mismatch). While a revoke is pending the old account is still alive on that instance, so a leaked host token still works there until it lands.
- A regenerated token removes the bot from its spaces on other instances (the account is recreated).
- The peer of the home instance is found by host without port; two instances on one host and different ports are not supported. `homeInstance` in `register` cannot carry a port.
- When a person replies to a message and mentions a bot, the event carries the replied text in `replyTo`.
- Slash commands run only in chats on the instance where the bot is connected; the other things not built are listed in section 5b. Voice has no per-seat status of the bot's own (mute, camera) (section 5c).
- Not built: per-bot permissions beyond roles, resume after reconnect, private (visible to one person) answers to slash commands.

## 8a. Revocation retries

`POST /api/bots/:id/token`, `DELETE /api/bots/:id` and deleting the owner's account all go through `revokeBotWithRetry` (`utils/botRevocationQueue.ts`): one signed `DELETE /api/federation/identity` per origin (idempotent on the host: no live account answers 200), and every failure that a later attempt can fix is kept as a row of `bot_revocations`, one per `(bot, origin)`. The background worker (`startFederationWorkers`, every 5 minutes) retries the rows that are due with a growing pause (5 min, 10, 20, ... up to 6 h). A row is deleted when the revoke lands, when the instance refuses it in a way that cannot change (403, 409, other 4xx), or after 7 days (a warning is logged). `full` (the bot was deleted) is never downgraded to `soft`; the rows hold no reference to `users`, so the bot's tombstone does not take them away.

While a row exists for a host, the home issues the bot no new credential or proof for it (`POST /api/users/@me/federation-credential` and `POST /api/auth/attach-proof` answer `409 bot_revocation_pending`): the old account there would block a new registration, and the late revoke would take a new account down. Other hosts are not affected. The bot's own credential rows are deleted at once, as before: they are not what the retry needs.

Covered end to end by `test/federation-e2e-bot-revocation-retry.test.ts`: the host goes away for the home (its peer row points at a port nobody listens on, so every call is refused as for a stopped host), the owner resets the tokens (the answer says `pending`), credential and proof for that host answer 409, a retry while it is away keeps the row, the host comes back, and the next retry tombstones the account there by a real signed call and empties the queue; the bot can then register again.

## 8b. Token migration

Before migration 0035 a bot's token was a JWT valid for 3650 days. Such a bot keeps working untouched until its owner creates its first `bsb_` token (Settings > Bots > Tokens, or `POST /api/bots/:id/tokens`). From that moment the old JWT is refused (REST, uploads and WebSocket answer `Token has been revoked`) and the sockets of the bot are closed, so create the token and give it to the program in one step. The rule applies to native bots only (`isBot`, no `homeInstance`, at least one row in `bot_tokens`); a bot's federated account on another instance logs in with its own session JWT and is not affected. Revoking the last token leaves the bot without any working token until a new one is created: that revoke also sets `users.password_changed_at`, so the old JWT does not come back.

## 9. Database

Migration `0032_bots.sql` adds to `users`: `is_bot` (INTEGER NOT NULL DEFAULT 0) and `bot_owner_id` (TEXT, the owner's user id) and an index `idx_users_bot_owner_id` on it. Nothing else is stored per bot; the avatar and display name are the ordinary `users` columns. The cascade and revocation rules are in 1 and 7.

Migration `0035_bot_tokens.sql` adds `bot_tokens`: `id` (16 hex, PK, the public part of the token), `bot_id` (FK to `users`, cascade), `token_hash` (SHA-256 of the secret, hex), `name` (nullable), `created_at`, `last_used_at` (nullable); index `idx_bot_tokens_bot_id`. A bot's rows are deleted when the bot is tombstoned.

Migration `0034_bot_revocations.sql` adds `bot_revocations`: `bot_id` and `origin` (primary key together, no foreign key), `mode` (`soft` | `full`), `attempts` (default 0), `last_error`, `created_at`, `next_attempt_at`; index on `next_attempt_at`.

The migration `0032_bots.sql` also adds the two tables of the slash commands. `bot_commands`: `id` (PK), `bot_id` (FK to `users`, cascade), `name`, `description`, `options` (JSON array, default `'[]'`), `updated_at`; unique index on `(bot_id, name)`. `interactions`: `id` (random 32-hex string, PK), `bot_id` and `user_id` (FKs to `users`, cascade), `channel_id` / `dm_channel_id` (exactly one is set), `command`, `options` (JSON object of the parsed values), `created_at`, `expires_at`, `responses` (default 0); index on `expires_at`. A spent interaction is dropped by the first invocation that comes a day after it expired. A bot's `bot_commands` rows are deleted when the bot is tombstoned.
