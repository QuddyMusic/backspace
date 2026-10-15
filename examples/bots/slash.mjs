// Slash command bot: registers /play, /stop and /poke and answers them.
// The server carries the call; what a command does is decided here.
//
//   BACKSPACE_URL=https://chat.example.com BOT_TOKEN=... node examples/bots/slash.mjs
import { createBot } from './client.mjs';

const bot = createBot({ baseUrl: process.env.BACKSPACE_URL, token: process.env.BOT_TOKEN });

const commands = [
  {
    name: 'play',
    description: 'Pretend to play a track',
    options: [
      { name: 'query', description: 'What to play', type: 'string', required: true },
      { name: 'volume', description: 'Volume', type: 'integer', choices: [{ name: 'low', value: 20 }, { name: 'high', value: 80 }] },
    ],
  },
  { name: 'stop', description: 'Stop playing' },
  {
    // Typed options: the person picks a user, a voice channel and a role; the
    // bot gets their ids in `options` and the objects in `resolved`.
    name: 'poke',
    description: 'Poke someone, somewhere',
    options: [
      { name: 'who', description: 'Who to poke', type: 'user', required: true },
      { name: 'times', description: 'How many times', type: 'integer', minValue: 1, maxValue: 5 },
      { name: 'where', description: 'A voice channel', type: 'channel', channelTypes: ['voice'] },
      { name: 'group', description: 'A role to name', type: 'role' },
      { name: 'loud', description: 'Shout it', type: 'boolean' },
      { name: 'note', description: 'A short note', type: 'string', minLength: 2, maxLength: 40 },
    ],
  },
];

bot.run(async (event) => {
  if (event.type === 'ready') {
    // The list is replaced as a whole, so doing this on every (re)connect is harmless.
    await bot.api('PUT', '/bots/@me/commands', { commands });
    console.log('commands registered');
    return;
  }
  if (event.type !== 'interaction_created') return;

  const { id, command, options, resolved, user } = event.interaction;
  const answer = (content) => bot.api('POST', `/interactions/${id}/respond`, { content });

  if (command === 'play') {
    await answer(`<@${user.id}> asked me to play "${options.query}" at volume ${options.volume ?? 'default'}`);
  } else if (command === 'stop') {
    await answer(`<@${user.id}> asked me to stop`);
  } else if (command === 'poke') {
    const target = resolved?.users?.[options.who];
    const where = options.where ? ` in #${resolved?.channels?.[options.where]?.name}` : '';
    const group = options.group ? ` (for ${resolved?.roles?.[options.group]?.name})` : '';
    const text = `poke ${target?.displayName ?? target?.username} x${options.times ?? 1}${where}${group}${options.note ? `: ${options.note}` : ''}`;
    await answer(options.loud ? text.toUpperCase() : text);
  }
});
