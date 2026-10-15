import { useLayoutEffect, useRef, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react';
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
 * The argument boxes are painted with backgrounds, radii and box-shadows only:
 * the mirror must lay its text out exactly as the textarea does, or the caret
 * and the painted text drift apart. The colon of `name:` stays in the text
 * (the parser reads it) but is drawn transparent inside the name's box. The
 * class strings are written out whole so Tailwind finds them.
 */
const NAME_BOX = 'bg-white/[0.08] text-txt-secondary rounded-l-[4px] [box-shadow:0_0_0_1px_rgba(255,255,255,0.16)]';
const COLON_BOX = 'bg-white/[0.08] text-transparent [box-shadow:0_0_0_1px_rgba(255,255,255,0.16)]';
const VALUE_BOX = 'bg-black/25 rounded-r-[4px] [box-shadow:0_0_0_1px_rgba(255,255,255,0.16)]';
const EMPTY_VALUE_BOX = 'relative inline-block w-0 after:content-[""] after:absolute after:left-0 after:bottom-[-0.3em] after:h-[1.25em] after:w-[2.5ch] after:bg-black/25 after:rounded-r-[4px] after:[box-shadow:0_0_0_1px_rgba(255,255,255,0.16)]';
const MENTION = 'rounded bg-accent-primary/15 text-accent-primary';

type Region = 'name' | 'colon' | 'value' | null;

function regionAt(frames: readonly ArgumentFrame[], position: number): Region {
  for (const frame of frames) {
    if (position >= frame.nameStart && position < frame.valueStart - 1) return 'name';
    if (position === frame.valueStart - 1) return 'colon';
    if (position >= frame.valueStart && position < frame.valueEnd) return 'value';
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
    cuts.add(frame.valueStart - 1);
    cuts.add(frame.valueStart);
    cuts.add(frame.valueEnd);
  }
  const emptyValues = new Set(frames.filter((f) => f.valueEnd === f.valueStart).map((f) => f.valueStart));
  const pieces: ReactNode[] = [];
  model.parts.forEach((part, index) => {
    const end = part.start + part.text.length;
    const points = [part.start, ...[...cuts].filter((c) => c > part.start && c < end).sort((a, b) => a - b), end];
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i]!;
      const to = points[i + 1]!;
      // A value not written yet is still shown as a box to fill in.
      if (emptyValues.has(from)) pieces.push(<span key={`empty-${from}`} className={EMPTY_VALUE_BOX} />);
      const text = part.text.slice(from - part.start, to - part.start);
      const offset = anchor - from;
      const content = offset >= 0 && offset < text.length
        ? <>{text.slice(0, offset)}{marker}{text.slice(offset)}</> : text;
      const region = regionAt(frames, from);
      const classes = [
        part.painted ? MENTION : '',
        region === 'name' ? NAME_BOX : '',
        region === 'colon' ? COLON_BOX : '',
        region === 'value' ? VALUE_BOX : '',
      ].filter(Boolean).join(' ');
      pieces.push(<span key={`${index}-${from}`} className={classes || undefined}>{content}</span>);
    }
  });
  // An empty value at the very end of the text has no piece to precede.
  if (emptyValues.has(model.text.length)) pieces.push(<span key="empty-end" className={EMPTY_VALUE_BOX} />);

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
