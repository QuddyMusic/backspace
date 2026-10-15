import type { BotCommandListing, BotCommandOption, ChannelType } from '@backspace/shared';

export type OptionValues = Record<string, string | number | boolean>;

/**
 * What the chat knows that typed values may name: its people, and its space's
 * roles and channels (none in a DM).
 */
export interface CommandArgContext {
  users: ReadonlyArray<{ id: string; username: string }>;
  roles: ReadonlyArray<{ id: string; name: string }>;
  channels: ReadonlyArray<{ id: string; name: string; type: ChannelType }>;
}

const NO_CONTEXT: CommandArgContext = { users: [], roles: [], channels: [] };

/** The one id whose name is `name` (case-insensitively), or null for none or several. */
function idByName<T extends { id: string }>(items: readonly T[], nameOf: (item: T) => string, name: string): string | null {
  const wanted = name.toLowerCase();
  const found = items.filter((item) => nameOf(item).toLowerCase() === wanted);
  return found.length === 1 ? found[0]!.id : null;
}

/**
 * The id a typed user, role or channel value stands for: a token from the
 * picker (`<@id>`, `<@&id>`), or a name written by hand (`@username`,
 * `@Role`, `#channel`, or the bare name) that names exactly one of them in
 * the chat; a channel must also be of an accepted type. Anything else goes
 * to the server as typed, which refuses it.
 */
function idOf(def: BotCommandOption, raw: string, context: CommandArgContext): string {
  if (def.type === 'user') {
    return /^<@([a-zA-Z0-9_-]+)>$/.exec(raw)?.[1]
      ?? idByName(context.users, (u) => u.username, raw.replace(/^@/, ''))
      ?? raw;
  }
  if (def.type === 'role') {
    return /^<@&([a-zA-Z0-9_-]+)>$/.exec(raw)?.[1]
      ?? idByName(context.roles, (r) => r.name.replace(/^@/, ''), raw.replace(/^@/, ''))
      ?? raw;
  }
  const channels = context.channels.filter((c) => !def.channelTypes || def.channelTypes.includes(c.type));
  return idByName(channels, (c) => c.name, raw.replace(/^#/, '')) ?? raw;
}

export interface OptionSuggest {
  command: BotCommandListing;
  /** What has been typed of the option name so far (lowercase). */
  query: string;
  /** Where that partial name starts in the draft. */
  startIndex: number;
  selectedIndex: number;
  /** An arrow key moved the selection: only then does Enter pick it instead of sending. */
  touched: boolean;
}

function setOptionValue(options: OptionValues, def: BotCommandOption, raw: string, context: CommandArgContext): void {
  if (raw.length === 0) return;
  if (def.type === 'integer' || def.type === 'number') {
    const n = Number(raw);
    options[def.name] = Number.isNaN(n) ? raw : n;
  } else if (def.type === 'boolean') {
    options[def.name] = raw === 'true' || raw === '1' || raw === 'yes';
  } else if (def.type === 'user' || def.type === 'role' || def.type === 'channel') {
    options[def.name] = idOf(def, raw, context);
  } else {
    options[def.name] = raw;
  }
}

/**
 * Reads the options written by name at the start of `text`: `name:value`, where
 * a value is one word, or several in double quotes. A string option written
 * without quotes runs up to the next option written by name, or to the end, so
 * a title or a message may be any length. `rest` is what follows the last pair.
 */
export function readNamedPairs(
  command: BotCommandListing,
  text: string,
  context: CommandArgContext = NO_CONTEXT,
): { options: OptionValues; rest: string } {
  const defs = new Map(command.options.map((o) => [o.name, o] as const));
  const nextNamed = new RegExp('\\s(?:' + command.options.map((o) => o.name).join('|') + '):', 'i');
  const options: OptionValues = {};
  let remaining = text.trim();
  for (;;) {
    const head = /^([a-z0-9_-]+):/i.exec(remaining);
    const def = head ? defs.get(head[1]!.toLowerCase()) : undefined;
    if (!head || !def) break;
    let body = remaining.slice(head[0].length).trimStart();
    let raw: string;
    const close = body.startsWith('"') ? body.indexOf('"', 1) : -1;
    if (close > 0) {
      raw = body.slice(1, close);
      body = body.slice(close + 1);
    } else if (def.type === 'string') {
      const cut = body.search(nextNamed);
      raw = (cut < 0 ? body : body.slice(0, cut)).trim();
      body = cut < 0 ? '' : body.slice(cut);
    } else {
      const space = body.search(/\s/);
      raw = space < 0 ? body : body.slice(0, space);
      body = space < 0 ? '' : body.slice(space);
    }
    setOptionValue(options, def, raw, context);
    remaining = body.trim();
  }
  return { options, rest: remaining };
}

/**
 * The option values typed after a command. Options come first as name:value
 * pairs; whatever is left, spaces and all, is the value of the last string
 * option that was not given by name. Returns the leftover text when the command
 * has no string option to take it.
 */
export function parseCommandArgs(
  command: BotCommandListing,
  rest: string,
  context: CommandArgContext = NO_CONTEXT,
): { ok: true; options: OptionValues } | { ok: false; extra: string } {
  const { options, rest: left } = readNamedPairs(command, rest, context);
  if (left.length === 0) return { ok: true, options };
  const target = [...command.options].reverse().find((o) => o.type === 'string' && !(o.name in options));
  if (!target) return { ok: false, extra: left };
  options[target.name] = left;
  return { ok: true, options };
}

/** The optional options of a command that the text does not name yet. */
export function remainingOptions(command: BotCommandListing, text: string): BotCommandOption[] {
  return command.options.filter(
    (o) => !o.required && !new RegExp('(?:^|\\s)' + o.name + ':', 'i').test(text),
  );
}

/**
 * The option popover state for a draft, or null when none applies: the text must
 * start with a known command and a space, everything after it must be options
 * written by name, and the word being typed must not be a value.
 */
export function suggestOptions(
  value: string,
  commands: BotCommandListing[],
  picked: BotCommandListing | null,
): OptionSuggest | null {
  const head = /^\/([a-z0-9_-]+)\s/i.exec(value);
  if (!head) return null;
  const name = head[1]!.toLowerCase();
  const command = picked && picked.name === name ? picked : commands.find((c) => c.name === name);
  if (!command || command.options.length === 0) return null;
  const tail = value.slice(head[0].length);
  const cut = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\n')) + 1;
  const partial = tail.slice(cut);
  if (partial.includes(':')) return null;
  if (readNamedPairs(command, tail.slice(0, cut)).rest.length > 0) return null;
  return { command, query: partial.toLowerCase(), startIndex: head[0].length + cut, selectedIndex: 0, touched: false };
}

/** The value popover of a typed option: which option, and what of its value is typed so far. */
export interface ValueSuggest {
  command: BotCommandListing;
  option: BotCommandOption;
  /** The value typed so far, lowercase, without a leading `#` (channel) or `@` (user, role). */
  query: string;
  /** Where the value starts in the draft. */
  startIndex: number;
  selectedIndex: number;
  /** An arrow key moved the selection: only then does Enter pick it instead of sending. */
  touched: boolean;
}

/** The option types whose values the popover offers. */
const PICKED_TYPES: ReadonlySet<BotCommandOption['type']> = new Set(['user', 'role', 'channel', 'boolean']);

/**
 * The value popover state for a draft, or null when none applies: the text must
 * start with a known command, everything before the word being typed must be
 * options written by name, and that word must be `name:` of a user, role,
 * channel or boolean option followed by the start of a value. A token or a
 * quoted value is not offered anything. (The mention picker does not open
 * here: it needs a space before the `@`.)
 */
export function suggestValue(
  value: string,
  commands: BotCommandListing[],
  picked: BotCommandListing | null,
): ValueSuggest | null {
  const head = /^\/([a-z0-9_-]+)\s/i.exec(value);
  if (!head) return null;
  const name = head[1]!.toLowerCase();
  const command = picked && picked.name === name ? picked : commands.find((c) => c.name === name);
  if (!command) return null;
  const tail = value.slice(head[0].length);
  const cut = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\n')) + 1;
  const word = /^([a-z0-9_-]+):(.*)$/i.exec(tail.slice(cut));
  if (!word) return null;
  const option = command.options.find((o) => o.name === word[1]!.toLowerCase());
  if (!option || !PICKED_TYPES.has(option.type)) return null;
  const partial = word[2]!;
  if (partial.startsWith('"') || partial.startsWith('<')) return null;
  if (readNamedPairs(command, tail.slice(0, cut)).rest.length > 0) return null;
  return {
    command,
    option,
    query: partial.replace(/^[#@]/, '').toLowerCase(),
    startIndex: head[0].length + cut + word[1]!.length + 1,
    selectedIndex: 0,
    touched: false,
  };
}
