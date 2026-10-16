import type { BotCommandListing, BotCommandOption, ChannelType } from '@backspace/shared';

export type OptionValues = Record<string, string | number | boolean>;

/**
 * The spacing the composer keeps around the arguments of a command draft, so
 * each argument's capsule has room inside and out (the capsules are painted
 * over the text and cannot add width of their own): an em space between the
 * command and its first argument, an em and an en space between arguments,
 * and a thin and an en space after a colon. `spaceArguments` writes it,
 * whether an argument was picked from a list, typed or pasted. The parser
 * reads any whitespace there, so text with plain spaces means the same; the
 * server only ever sees the parsed options.
 */
export const HEAD_GAP = '\u2003';
export const ARG_SEPARATOR = '\u2003\u2002';
export const VALUE_GAP = '\u2009\u2002';

/** The command a draft starts with (`/name` and whitespace), lowercase, or null. */
export function draftCommandName(text: string): string | null {
  return /^\/([a-z0-9_-]+)\s/i.exec(text)?.[1]?.toLowerCase() ?? null;
}

/**
 * What the chat knows that typed values may name: its people, and its space's
 * roles and channels (none in a DM).
 */
export interface CommandArgContext {
  /** Each person with every name the chat shows for them: login, display name, space nickname. */
  users: ReadonlyArray<{ id: string; names: readonly string[] }>;
  roles: ReadonlyArray<{ id: string; name: string }>;
  channels: ReadonlyArray<{ id: string; name: string; type: ChannelType }>;
}

const NO_CONTEXT: CommandArgContext = { users: [], roles: [], channels: [] };

/** The one id with a name equal to `name` (case-insensitively), or null for none or several. */
function idByName<T extends { id: string }>(
  items: readonly T[],
  namesOf: (item: T) => readonly string[],
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  const ids = new Set(items.filter((item) => namesOf(item).some((n) => n.toLowerCase() === wanted)).map((item) => item.id));
  return ids.size === 1 ? [...ids][0]! : null;
}

/**
 * The id a typed user, role or channel value stands for: a token from the
 * picker (`<@id>`, `<@&id>`), or a name written by hand (`@login`, `@Display
 * name` in quotes, `@Role`, `#channel`, or the bare name) that names exactly one of them in
 * the chat; a channel must also be of an accepted type. Anything else goes
 * to the server as typed, which refuses it.
 */
function idOf(def: BotCommandOption, raw: string, context: CommandArgContext): string {
  if (def.type === 'user') {
    return /^<@([a-zA-Z0-9_-]+)>$/.exec(raw)?.[1]
      ?? idByName(context.users, (u) => u.names, raw.replace(/^@/, ''))
      ?? raw;
  }
  if (def.type === 'role') {
    return /^<@&([a-zA-Z0-9_-]+)>$/.exec(raw)?.[1]
      ?? idByName(context.roles, (r) => [r.name.replace(/^@/, '')], raw.replace(/^@/, ''))
      ?? raw;
  }
  const channels = context.channels.filter((c) => !def.channelTypes || def.channelTypes.includes(c.type));
  return idByName(channels, (c) => [c.name], raw.replace(/^#/, '')) ?? raw;
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

/**
 * The value of the choice `raw` names: a choice's name (what the list shows
 * and inserts) or its value written as is, case-insensitively. Undefined when
 * it is neither; the typed text then goes to the server, which refuses it.
 */
function choiceValue(def: BotCommandOption, raw: string): string | number | undefined {
  const wanted = raw.toLowerCase();
  const byName = def.choices?.find((c) => c.name.toLowerCase() === wanted);
  if (byName) return byName.value;
  return def.choices?.find((c) => String(c.value).toLowerCase() === wanted)?.value;
}

function setOptionValue(options: OptionValues, def: BotCommandOption, raw: string, context: CommandArgContext): void {
  if (raw.length === 0) return;
  const chosen = def.choices ? choiceValue(def, raw) : undefined;
  if (chosen !== undefined) {
    options[def.name] = chosen;
  } else if (def.type === 'integer' || def.type === 'number') {
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
    const nextName = /^([a-z0-9_-]+):/i.exec(body);
    if (nextName && defs.has(nextName[1]!.toLowerCase())) {
      // `a: b:value`: a was left empty, b follows.
      raw = '';
    } else if (close > 0) {
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

/**
 * The options of a command that the draft `text` (`/name ...`) does not name
 * yet, the required ones first. A `name:` inside a quoted value names nothing.
 */
export function remainingOptions(command: BotCommandListing, text: string): BotCommandOption[] {
  const written = new Set(argumentFrames(text, command).map((f) => text.slice(f.nameStart, f.colonAt).toLowerCase()));
  const missing = command.options.filter((o) => !written.has(o.name));
  return [...missing.filter((o) => o.required), ...missing.filter((o) => !o.required)];
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
  // The word being typed starts after the last whitespace of any kind.
  let cut = tail.length;
  while (cut > 0 && !/\s/.test(tail[cut - 1]!)) cut--;
  const partial = tail.slice(cut);
  if (partial.includes(':')) return null;
  // `name: ` with no value yet: its values are offered, not more options.
  if (/(?:^|\s)[a-z0-9_-]+:\s+$/i.test(tail)) return null;
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

/** The option types whose values the popover offers; any option with choices is offered its choices. */
const PICKED_TYPES: ReadonlySet<BotCommandOption['type']> = new Set(['user', 'role', 'channel', 'boolean']);

/** Whether the value popover offers anything for `option`. */
export function offersValues(option: BotCommandOption): boolean {
  return PICKED_TYPES.has(option.type) || (option.choices?.length ?? 0) > 0;
}

/**
 * The value popover state for a draft, or null when none applies: the text must
 * start with a known command, everything before the last `name:` must be
 * options written by name, and it must be `name:` (or `name: `) of a user, role,
 * channel or boolean option, or of an option with choices, followed by the
 * start of a value. A token or a
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
  // The option being filled is the last `name:` of the text, its value written
  // right after the colon or after its gap (`who:bo`, `who: bo`, VALUE_GAP).
  const word = /(^|\s)([a-z0-9_-]+):([^\S\n]{0,2})(\S*)$/i.exec(tail);
  if (!word) return null;
  const option = command.options.find((o) => o.name === word[2]!.toLowerCase());
  if (!option || !offersValues(option)) return null;
  const partial = word[4]!;
  if (partial.startsWith('"') || partial.startsWith('<')) return null;
  const before = word.index + word[1]!.length;
  if (readNamedPairs(command, tail.slice(0, before)).rest.length > 0) return null;
  return {
    command,
    option,
    query: partial.replace(/^[#@]/, '').toLowerCase(),
    startIndex: head[0].length + before + word[2]!.length + 1 + word[3]!.length,
    selectedIndex: 0,
    touched: false,
  };
}

/** One argument of a command draft as the composer frames it: its `name:` and its value. */
export interface ArgumentFrame {
  /** Where `name:` starts; the name's box runs to `valueStart`. */
  nameStart: number;
  /** The colon, drawn hidden inside the name's box. */
  colonAt: number;
  /** Where the value's box starts: after the colon (and a thin space right after it). */
  valueStart: number;
  /** Where the value ends; equal to `valueStart` while no value is written. */
  valueEnd: number;
}

/**
 * Where the arguments of a draft that starts with `command` sit, in the text
 * as the textarea shows it, so the composer can draw each as a capsule:
 * `name:` and its value. A value is read as the parser reads it: one word, a
 * quoted run, or for a string option written without quotes, everything up
 * to the next option written by name. `units` are spans that count as one
 * word whatever they hold (a mention shown as `@Display name`).
 */
export function argumentFrames(
  text: string,
  command: BotCommandListing,
  units: ReadonlyArray<{ start: number; end: number }> = [],
): ArgumentFrame[] {
  const head = new RegExp('^/' + command.name + '\\s', 'i').exec(text);
  if (!head || command.options.length === 0) return [];
  const types = new Map(command.options.map((o) => [o.name, o.type] as const));
  const names = command.options.map((o) => o.name).join('|');
  const named = new RegExp('(^|\\s)(' + names + '):', 'gi');
  const starts: Array<{ nameStart: number; colonAt: number; name: string }> = [];
  // A quoted value runs to its closing quote, whatever it holds; so does the parser.
  let quotedUntil = 0;
  for (let m = named.exec(text); m; m = named.exec(text)) {
    if (m.index + m[1]!.length < head[0].length) continue;
    const nameStart = m.index + m[1]!.length;
    if (nameStart < quotedUntil) continue;
    // A `name:` inside a mention's shown name is part of the mention.
    if (units.some((u) => nameStart > u.start && nameStart < u.end)) continue;
    const colonAt = nameStart + m[2]!.length;
    starts.push({ nameStart, colonAt, name: m[2]!.toLowerCase() });
    const from = colonAt + 1 + /^[^\S\n]*/.exec(text.slice(colonAt + 1))![0].length;
    if (text[from] === '"') {
      const close = text.indexOf('"', from + 1);
      quotedUntil = close < 0 ? text.length : close + 1;
    }
  }
  return starts.map((start, i) => {
    const next = starts[i + 1]?.nameStart ?? text.length;
    // A thin space right after the colon pads the name; the spacing after it pads the value.
    const valueStart = start.colonAt + 1 + (text[start.colonAt + 1] === '\u2009' ? 1 : 0);
    const gap = /^[^\S\n]*/.exec(text.slice(valueStart, next))![0].length;
    const from = valueStart + gap;
    const rest = text.slice(from, next);
    let length: number;
    if (rest.startsWith('"')) {
      const close = rest.indexOf('"', 1);
      length = close > 0 ? close + 1 : rest.length;
    } else if (types.get(start.name) === 'string') {
      length = rest.trimEnd().length;
    } else {
      const unit = units.find((u) => u.start === from);
      const space = rest.search(/\s/);
      length = unit ? unit.end - unit.start : space < 0 ? rest.length : space;
    }
    return { nameStart: start.nameStart, colonAt: start.colonAt, valueStart, valueEnd: length > 0 ? from + length : valueStart };
  });
}

/**
 * Writes the composer's spacing (`HEAD_GAP`, `ARG_SEPARATOR`, `VALUE_GAP`)
 * around every argument of a draft that starts with `command`, in place of
 * whatever whitespace is there, and moves `caret` with the text. Only the
 * runs of spaces around `name:` change; a value's own spaces and line breaks
 * stay as written. A caret in the run after a colon goes behind the value's
 * gap, into the value's slot; a run before a name that holds the caret is left
 * as typed, since the person is writing there. Text already spaced comes back
 * unchanged.
 */
export function spaceArguments(text: string, command: BotCommandListing, caret: number): { text: string; caret: number } {
  const frames = argumentFrames(text, command);
  const head = /^\/[a-z0-9_-]+/i.exec(text);
  if (!head || frames.length === 0) return { text, caret };
  const isSpace = (char: string | undefined) => char !== undefined && /[^\S\n]/.test(char);
  // `caretAt`: where a caret in the run goes, as an offset into `insert`; null
  // leaves a run that holds the caret alone.
  const edits: Array<{ start: number; end: number; insert: string; caretAt: number | null }> = [];
  let spacedUpTo = -1;
  frames.forEach((frame, i) => {
    // Before the name, unless the run after the previous colon already covered it.
    let start = frame.nameStart;
    while (isSpace(text[start - 1])) start--;
    if (frame.nameStart > spacedUpTo && start > 0 && text[start - 1] !== '\n') {
      edits.push({ start, end: frame.nameStart, insert: start === head[0].length ? HEAD_GAP : ARG_SEPARATOR, caretAt: null });
    }
    // After the colon: the value's gap, and the separator too when no value follows.
    const from = frame.colonAt + 1;
    let end = from;
    while (isSpace(text[end])) end++;
    if (end < text.length && text[end] === '\n') return;
    const next = frames[i + 1];
    if (next && end === next.nameStart) {
      edits.push({ start: from, end, insert: VALUE_GAP + ARG_SEPARATOR, caretAt: VALUE_GAP.length });
      spacedUpTo = end;
    } else {
      edits.push({ start: from, end, insert: VALUE_GAP, caretAt: VALUE_GAP.length });
    }
  });
  let spaced = text;
  let moved = caret;
  for (const edit of [...edits].reverse()) {
    const inside = edit.caretAt === null
      ? caret > edit.start && caret <= edit.end
      : caret >= edit.start && caret <= edit.end;
    if (inside && edit.caretAt === null) continue;
    if (text.slice(edit.start, edit.end) !== edit.insert) {
      spaced = spaced.slice(0, edit.start) + edit.insert + spaced.slice(edit.end);
    }
    if (inside) moved += edit.start + edit.caretAt! - caret;
    else if (caret > edit.end) moved += edit.insert.length - (edit.end - edit.start);
  }
  return { text: spaced, caret: moved };
}
