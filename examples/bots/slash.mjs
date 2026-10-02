import { createBot } from './client.mjs';

const bot = createBot({ baseUrl: process.env.BACKSPACE_URL, token: process.env.BOT_TOKEN });

bot.run(async (event) => {
  if (event.type === 'ready') {
    await bot.api('PUT', '/bots/@me/commands', {
      commands: [
        {
          name: 'play',
          description: 'Pretend to play a track',
          options: [
            { name: 'query', description: 'What to play', type: 'string', required: true },
            { name: 'volume', description: 'Volume', type: 'integer', choices: [{ name: 'low', value: 20 }, { name: 'high', value: 80 }] },
          ],
        },
      ],
    });
    console.log('commands registered');
    return;
  }
  if (event.type !== 'interaction_created') return;
  const i = event.interaction;
  await bot.api('POST', `/interactions/${i.id}/respond`, {
    content: `<@${i.user.id}> asked me to play "${i.options.query}" at volume ${i.options.volume ?? 'default'}`,
  });
});
