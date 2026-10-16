import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react';
import type { ComposerMentions } from './composerMentions';
import type { ArgumentFrame } from '../../utils/commandArgs';

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  model: ComposerMentions;
  textareaRef: RefObject<HTMLTextAreaElement>;
  mentionAnchorRef: RefObject<HTMLSpanElement>;
  mentionStart?: number;
  /** The arguments of a slash command draft, in shown offsets: each is drawn as a box. */
  frames?: readonly ArgumentFrame[];
}

/*
 * An argument is drawn as one capsule in two tones, like the glass pills of
 * the design system: the option's name on the lighter half, its value on the
 * darker one, framed by a line (dashed while no value is written). Only
 * backgrounds, radii, box-shadows and absolutely placed pseudo-elements are
 * used: the mirror must lay its text out exactly as the textarea does, or the
 * caret and the painted text drift apart. The room inside and between the
 * capsules is the spacing the composer writes (see `ARG_SEPARATOR` and
 * `VALUE_GAP`): the colon of `name:` and a thin space after it are the name's
 * right padding, drawn transparent, an en space is the value's left padding,
 * and the outer ends are widened by a shadow in the capsule's colour. The
 * class strings are written out whole so Tailwind finds them.
 */
const NAME_BOX = 'bg-white/[0.10] text-txt-secondary rounded-l-md [box-shadow:-6px_0_0_0_rgba(255,255,255,0.10)]';
const COLON = 'text-transparent';
const VALUE_BOX = 'relative bg-white/[0.05] text-txt-primary rounded-r-md [box-shadow:6px_0_0_0_rgba(255,255,255,0.05)] after:content-[""] after:pointer-events-none after:absolute after:inset-y-0 after:left-0 after:-right-[6px] after:rounded-r-md after:border after:border-white/25';
const EMPTY_VALUE_BOX = 'relative inline-block w-0 after:content-[""] after:absolute after:left-0 after:bottom-[-0.28em] after:h-[1.2em] after:w-[var(--slot)] after:rounded-r-md after:border after:border-dashed after:border-white/25 after:bg-white/[0.03]';
const MENTION = 'rounded bg-accent-primary/15 text-accent-primary';

/** Rough widths of the spaces a draft holds, in em, to size an empty value's slot. */
const SPACE_WIDTHS: Record<string, number> = { '\u2002': 0.5, '\u2003': 1, '\u2009': 0.2 };

/**
 * How wide the slot of an empty value is drawn: generous at the end of the
 * text, and inside the spacing that follows it otherwise, so it never runs
 * under the next argument's capsule.
 */
function slotWidth(text: string, frame: ArgumentFrame, next: ArgumentFrame | undefined): string {
  const after = text.slice(frame.valueStart, next ? next.nameStart : text.length);
  if (!next && after.trim() === '') return '2em';
  let room = 0;
  for (const char of after) room += SPACE_WIDTHS[char] ?? 0.28;
  return Math.max(0.75, room - 1).toFixed(2) + 'em';
}

type Region = 'name' | 'colon' | 'value';

/** Which capsule half `position` falls in: the frame's index and the region, or null outside every capsule. */
function regionAt(frames: readonly ArgumentFrame[], position: number): { frame: number; region: Region } | null {
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (position >= f.nameStart && position < f.colonAt) return { frame: i, region: 'name' };
    if (position >= f.colonAt && position < f.valueStart) return { frame: i, region: 'colon' };
    if (position >= f.valueStart && position < f.valueEnd) return { frame: i, region: 'value' };
  }
  return null;
}

/** A native textarea retains IME, selection and paste behavior; its mirror paints mentions and command arguments. */
export function MentionTextarea({ model, textareaRef, mentionAnchorRef, mentionStart, frames = [], ...props }: Props) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const anchor = mentionStart === undefined ? -1 : model.toDisplay(mentionStart);
  const marker = (
    <span ref={mentionAnchorRef} className="inline-block w-0 h-[1.375rem] align-bottom" />
  );
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    // Match native input metrics, including iOS's 16px font rule and scrollbar width.
    const sync = () => {
      const style = getComputedStyle(textarea);
      mirror.style.font = style.font;
      mirror.style.letterSpacing = style.letterSpacing;
      mirror.style.padding = style.padding;
      mirror.style.width = textarea.clientWidth + 'px';
      mirror.style.transform = 'translateY(-' + textarea.scrollTop + 'px)';
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [textareaRef, model.text]);

  // Every part is cut where an argument's name, colon or value starts or ends,
  // so each piece has one look; a mention keeps its own paint inside a value.
  const cuts = new Set<number>();
  for (const frame of frames) {
    cuts.add(frame.nameStart);
    cuts.add(frame.colonAt);
    cuts.add(frame.valueStart);
    cuts.add(frame.valueEnd);
  }
  const emptySlots = new Map<number, string>();
  frames.forEach((frame, i) => {
    if (frame.valueEnd === frame.valueStart) emptySlots.set(frame.valueStart, slotWidth(model.text, frame, frames[i + 1]));
  });
  const slot = (at: number) => (
    <span key={`empty-${at}`} className={EMPTY_VALUE_BOX} style={{ '--slot': emptySlots.get(at) } as CSSProperties} />
  );

  // The pieces of one capsule half are wrapped together, so its frame is drawn once around them.
  const pieces: ReactNode[] = [];
  let group: { key: string; region: Region; children: ReactNode[] } | null = null;
  const flush = () => {
    if (!group) return;
    pieces.push(<span key={group.key} className={group.region === 'value' ? VALUE_BOX : NAME_BOX}>{group.children}</span>);
    group = null;
  };
  model.parts.forEach((part, index) => {
    const end = part.start + part.text.length;
    const points = [part.start, ...[...cuts].filter((c) => c > part.start && c < end).sort((a, b) => a - b), end];
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i]!;
      const to = points[i + 1]!;
      // A value not written yet is still shown as a box to fill in.
      if (emptySlots.has(from)) { flush(); pieces.push(slot(from)); }
      const text = part.text.slice(from - part.start, to - part.start);
      const offset = anchor - from;
      const content = offset >= 0 && offset < text.length
        ? <>{text.slice(0, offset)}{marker}{text.slice(offset)}</> : text;
      const at = regionAt(frames, from);
      const classes = [part.painted ? MENTION : '', at?.region === 'colon' ? COLON : ''].filter(Boolean).join(' ');
      const piece = <span key={`${index}-${from}`} className={classes || undefined}>{content}</span>;
      const key = at ? `${at.frame}-${at.region === 'value' ? 'value' : 'name'}` : null;
      if (group && group.key !== key) flush();
      if (!at) { pieces.push(piece); continue; }
      group ??= { key: key!, region: at.region === 'value' ? 'value' : 'name', children: [] };
      group.children.push(piece);
    }
  });
  flush();
  // An empty value at the very end of the text has no piece to precede.
  if (emptySlots.has(model.text.length)) pieces.push(slot(model.text.length));

  return <div className="relative flex-1 min-w-0">
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
      <div ref={mirrorRef} className="py-[10px] px-1 text-[15px] leading-[1.375rem] text-txt-primary whitespace-pre-wrap break-words">
        {pieces}
        {'​'}
      </div>
    </div>
    {/* The mirror paints the text; the textarea keeps only its caret,
        selection and placeholder. */}
    <textarea {...props} ref={textareaRef} value={model.text}
      className={`${props.className ?? ''} text-transparent caret-txt-primary`}
      onScroll={event => {
        if (mirrorRef.current) mirrorRef.current.style.transform = 'translateY(-' + event.currentTarget.scrollTop + 'px)';
        props.onScroll?.(event);
      }} />
  </div>;
}
