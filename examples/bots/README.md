# Bot examples

Node clients for the Bot API (Node 22 or newer); all of them are dependency-free except `tts-voice/`. The reference is `docs/systems/bots.md`.

1. In Settings > Bots create a bot and copy the token (it is shown once).
2. Bring the bot into a space (Settings > Bots, or `POST /api/bots/:id/spaces`) or message it directly.
3. Run an example:

```sh
BACKSPACE_URL=https://chat.example.com BOT_TOKEN=... node examples/bots/echo.mjs
```

| File | Behaviour |
|------|-----------|
| `client.mjs` | REST helper and a reconnecting WebSocket loop |
| `echo.mjs` | Repeats direct messages |
| `mention-reply.mjs` | Answers when mentioned (channels, group DMs) and to everything in a 1-on-1 DM |
| `react.mjs` | Reacts to messages containing `!ok` |
| `slash.mjs` | Registers slash commands (`/play`, `/stop`) and answers them |
| `voice.mjs` | The Backspace side of a bot in several voice channels at once (no audio: connect LiveKit where marked) |
| `tts-voice/` | A working voice bot: `/tts <text>` speaks English and Russian in your voice channel, leaves after 10 idle seconds, `/stop` leaves at once (runs in Docker) |

What a bot does with an event is the bot's own code. The server sends every event the bot may see, and it does not decide for the bot when it speaks.

## tts-voice

Speech comes from Piper (voices `en_US-lessac-medium` and `ru_RU-irina-medium`); a word in Cyrillic is read by the Russian voice, a Latin word by the English one. The audio goes out through `@livekit/rtc-node`, a native library without a musl build, so the image is Debian-based.

```sh
docker build -f examples/bots/tts-voice/Dockerfile -t backspace-tts-bot examples/bots
read -rs BOT_TOKEN; export BOT_TOKEN
docker run --rm -it --init --network host -e BOT_TOKEN -e BACKSPACE_URL=https://chat.example.com backspace-tts-bot
```

The bot joins the voice channel of whoever calls it. `--init` makes Ctrl+C work. The bot must be a member of the space.
