import { describe, expect, it } from 'vitest';
import type { BotCommandListing, BotCommandOption } from '@backspace/shared';
import { argumentFrames, parseCommandArgs, remainingOptions, suggestOptions, suggestValue, type CommandArgContext } from './commandArgs';

function option(name: string, type: BotCommandOption['type'], required = false): BotCommandOption {
  return { name, description: name, type, required };
}

function listing(name: string, options: BotCommandOption[]): BotCommandListing {
  return {
    id: `cmd-${name}`,
    botId: 'bot-1',
    name,
    description: name,
    options,
    updatedAt: 0,
    bot: { id: 'bot-1', username: 'player_bot', displayName: 'player_bot', avatar: null, avatarColor: 'mint' },
  };
}

const play = listing('play', [option('query', 'string', true), option('volume', 'integer'), option('loop', 'boolean')]);
const roll = listing('roll', [option('sides', 'integer')]);

describe('parseCommandArgs', () => {
  it('gives the text after named options to the last string option not named', () => {
    expect(parseCommandArgs(play, 'volume:80 любое название')).toEqual({
      ok: true,
      options: { volume: 80, query: 'любое название' },
    });
  });

  it('takes plain text as the last string option', () => {
    expect(parseCommandArgs(play, 'hello there')).toEqual({ ok: true, options: { query: 'hello there' } });
  });

  it('reads a quoted value of several words', () => {
    expect(parseCommandArgs(play, 'query:"hello world" loop:true')).toEqual({
      ok: true,
      options: { query: 'hello world', loop: true },
    });
  });

  it('lets a string option run up to the next named option', () => {
    expect(parseCommandArgs(play, 'query:some long title volume:5')).toEqual({
      ok: true,
      options: { query: 'some long title', volume: 5 },
    });
  });

  it('keeps a URL as text, not as a named option', () => {
    expect(parseCommandArgs(play, 'https://example.org/a?b=c')).toEqual({
      ok: true,
      options: { query: 'https://example.org/a?b=c' },
    });
  });

  it('keeps a non-numeric value as written, for the server to refuse', () => {
    expect(parseCommandArgs(play, 'volume:loud query:x')).toEqual({
      ok: true,
      options: { volume: 'loud', query: 'x' },
    });
  });

  it('reports the leftover text when no string option can take it', () => {
    expect(parseCommandArgs(roll, 'sides:6 extra words')).toEqual({ ok: false, extra: 'extra words' });
  });

  it('reads boolean spellings', () => {
    expect(parseCommandArgs(play, 'query:x loop:yes')).toEqual({ ok: true, options: { query: 'x', loop: true } });
    expect(parseCommandArgs(play, 'query:x loop:no')).toEqual({ ok: true, options: { query: 'x', loop: false } });
  });

  it('leaves a missing required option to the server', () => {
    expect(parseCommandArgs(play, '')).toEqual({ ok: true, options: {} });
  });
});

describe('remainingOptions', () => {
  it('offers the optional options that are not written yet', () => {
    expect(remainingOptions(play, '/play query:x volume:3').map((o) => o.name)).toEqual(['loop']);
    expect(remainingOptions(play, '/play query:x').map((o) => o.name)).toEqual(['volume', 'loop']);
  });
});

describe('suggestOptions', () => {
  const commands = [play, roll];

  it('opens after "/name " and follows the word being typed', () => {
    expect(suggestOptions('/play ', commands, null)).toMatchObject({ query: '', startIndex: 6 });
    expect(suggestOptions('/play vo', commands, null)).toMatchObject({ query: 'vo', startIndex: 6 });
    expect(suggestOptions('/play VO', commands, null)).toMatchObject({ query: 'vo', startIndex: 6 });
  });

  it('opens again after a complete named option', () => {
    expect(suggestOptions('/play query:x ', commands, null)).toMatchObject({ query: '', startIndex: 14 });
  });

  it('stays closed while free text is typed', () => {
    expect(suggestOptions('/play hello wor', commands, null)).toBeNull();
  });

  it('stays closed while a value is being typed', () => {
    expect(suggestOptions('/play vol:', commands, null)).toBeNull();
  });

  it('stays closed for an unknown command or before the space', () => {
    expect(suggestOptions('/nope ', commands, null)).toBeNull();
    expect(suggestOptions('/play', commands, null)).toBeNull();
  });

  it('prefers the command that was picked from the list', () => {
    expect(suggestOptions('/play ', [], play)).toMatchObject({ query: '', startIndex: 6 });
  });
});

describe('typed values', () => {
  const kick = listing('kick', [
    option('who', 'user', true),
    { ...option('where', 'channel'), channelTypes: ['voice'] },
    option('group', 'role'),
    option('reason', 'string'),
  ]);
  const context: CommandArgContext = {
    users: [{ id: 'u1', names: ['bob', 'Bobby'] }, { id: 'u2', names: ['Ann'] }, { id: 'u3', names: ['quddymusic', 'Quddy'] }],
    roles: [{ id: 'r1', name: 'Mods' }, { id: 'r2', name: 'mods-old' }],
    channels: [
      { id: 'c1', name: 'lounge', type: 'voice' },
      { id: 'c2', name: 'general', type: 'text' },
      { id: 'c3', name: 'general', type: 'voice' },
    ],
  };

  it('reads the tokens the picker writes', () => {
    expect(parseCommandArgs(kick, 'who:<@u9> group:<@&r9> where:#lounge spamming', context)).toEqual({
      ok: true,
      options: { who: 'u9', group: 'r9', where: 'c1', reason: 'spamming' },
    });
  });

  it('turns names written by hand into ids when exactly one matches', () => {
    expect(parseCommandArgs(kick, 'who:@ann group:@mods where:general', context)).toEqual({
      ok: true,
      // Two channels are named general, but only one is a voice channel.
      options: { who: 'u2', group: 'r1', where: 'c3' },
    });
  });

  it('matches a person by login, display name or nickname, and a quoted channel name with a space', () => {
    const spaced: CommandArgContext = { ...context, channels: [{ id: 'c9', name: 'Big Voice', type: 'voice' }] };
    expect(parseCommandArgs(kick, 'who:@Quddy where:"#Big Voice"', spaced)).toEqual({
      ok: true,
      options: { who: 'u3', where: 'c9' },
    });
    expect(parseCommandArgs(kick, 'who:bobby', context)).toEqual({ ok: true, options: { who: 'u1' } });
  });

  it('leaves an unknown name as written, for the server to refuse', () => {
    expect(parseCommandArgs(kick, 'who:@nobody where:#general2', context)).toEqual({
      ok: true,
      options: { who: '@nobody', where: '#general2' },
    });
  });
});

describe('suggestValue', () => {
  const ban = listing('ban', [option('who', 'user', true), option('silent', 'boolean'), option('reason', 'string')]);

  it('opens while the value of a user, role, channel or boolean option is typed', () => {
    expect(suggestValue('/ban who:', [ban], null)).toMatchObject({ query: '', startIndex: 9 });
    expect(suggestValue('/ban who:@Bo', [ban], null)).toMatchObject({ query: 'bo', startIndex: 9 });
    expect(suggestValue('/ban who:<@u1> silent:t', [ban], null)).toMatchObject({ query: 't', startIndex: 22 });
  });

  it('stays closed for a string option, a token, a quoted value and free text before', () => {
    expect(suggestValue('/ban reason:', [ban], null)).toBeNull();
    expect(suggestValue('/ban who:<@u1', [ban], null)).toBeNull();
    expect(suggestValue('/ban who:"bo', [ban], null)).toBeNull();
    expect(suggestValue('/ban hello who:', [ban], null)).toBeNull();
  });
});

describe('choices', () => {
  const vol = listing('vol', [
    { ...option('level', 'integer', true), choices: [{ name: 'quiet', value: 20 }, { name: 'very loud', value: 95 }] },
    { ...option('mode', 'string'), choices: [{ name: 'Shuffle', value: 'shuffle' }] },
  ]);

  it('sends the value of a choice written by name, quoted or not, or by its value', () => {
    expect(parseCommandArgs(vol, 'level:quiet mode:Shuffle')).toEqual({ ok: true, options: { level: 20, mode: 'shuffle' } });
    expect(parseCommandArgs(vol, 'level:"very loud"')).toEqual({ ok: true, options: { level: 95 } });
    expect(parseCommandArgs(vol, 'level:95')).toEqual({ ok: true, options: { level: 95 } });
  });

  it('leaves a name that is not a choice for the server to refuse', () => {
    expect(parseCommandArgs(vol, 'level:medium')).toEqual({ ok: true, options: { level: 'medium' } });
  });

  it('opens the value list for an option with choices', () => {
    expect(suggestValue('/vol level:q', [vol], null)).toMatchObject({ query: 'q', startIndex: 11 });
    expect(suggestValue('/vol mode:', [vol], null)).toMatchObject({ query: '' });
  });
});

describe('argumentFrames', () => {
  it('frames each name: and its value, a quoted value and a free-text string up to the next name', () => {
    const text = '/play query:any long title volume:80 loop:';
    const frames = argumentFrames(text, play);
    expect(frames.map((f) => [text.slice(f.nameStart, f.valueStart), text.slice(f.valueStart, f.valueEnd)])).toEqual([
      ['query:', 'any long title'],
      ['volume:', '80'],
      ['loop:', ''],
    ]);
    const quoted = '/play query:"a b" loop:true';
    expect(argumentFrames(quoted, play).map((f) => quoted.slice(f.valueStart, f.valueEnd))).toEqual(['"a b"', 'true']);
  });

  it('takes a shown mention as one value, and frames nothing for another command or before the space', () => {
    const kick = listing('kick', [option('who', 'user', true), option('reason', 'string')]);
    const text = '/kick who:@Bob Smith reason:spam';
    const frames = argumentFrames(text, kick, [{ start: 10, end: 20 }]);
    expect(text.slice(frames[0]!.valueStart, frames[0]!.valueEnd)).toBe('@Bob Smith');
    expect(argumentFrames('/play', play)).toEqual([]);
    expect(argumentFrames('/roll sides:6', play)).toEqual([]);
  });
});
