import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { BotCommandListing } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { BotBadge } from '../ui/BotBadge';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../api/client';

interface CommandPopoverProps {
  /** The matching commands, already filtered; the composer owns the list so its keys and this popover index the same rows. */
  commands: BotCommandListing[];
  selectedIndex: number;
  onSelect: (command: BotCommandListing) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

function CommandList({
  commands,
  selectedIndex,
  onSelect,
  selectedRef,
  mobile,
}: Omit<CommandPopoverProps, 'anchorRef'> & { selectedRef: React.RefObject<HTMLDivElement>; mobile: boolean }) {
  const { t } = useTranslation(['chat']);
  return (
    <>
      <div className="px-2 py-1.5 text-[11px] font-bold text-txt-tertiary uppercase tracking-wider">
        {t('chat:commands.title')}
      </div>
      {commands.map((command, i) => (
        <div
          key={command.id}
          ref={i === selectedIndex ? selectedRef : undefined}
          onClick={() => onSelect(command)}
          className={`flex items-center mx-1 rounded cursor-pointer transition-colors ${
            mobile ? 'gap-3 px-3 py-2.5 min-h-[44px]' : 'gap-2.5 px-2 py-1.5'
          } ${i === selectedIndex ? 'bg-interactive-selected' : 'hover:bg-interactive-hover'}`}
        >
          <Avatar
            src={command.bot.avatar ? api.uploads.url(command.bot.avatar) : null}
            name={command.bot.displayName || command.bot.username}
            size={mobile ? 28 : 24}
            avatarColor={command.bot.avatarColor}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={`${mobile ? 'text-[15px]' : 'text-[14px]'} font-medium text-txt-primary shrink-0`}>
                /{command.name}
              </span>
              <span className="text-[12px] text-txt-tertiary truncate">{command.description}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[11px] text-txt-tertiary truncate">@{command.bot.username}</span>
              <BotBadge />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

function DesktopCommands({ commands, selectedIndex, onSelect, anchorRef }: CommandPopoverProps) {
  const selectedRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const { style } = useFloatingPosition(anchorRef, floatingRef, {
    placement: 'top',
    offset: 4,
    enabled: commands.length > 0,
  });

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return createPortal(
    <div ref={floatingRef} style={style} className="w-[340px]">
      <div className="glass rounded-lg overflow-hidden max-h-[320px] overflow-y-auto scrollbar-thin">
        <CommandList commands={commands} selectedIndex={selectedIndex} onSelect={onSelect} selectedRef={selectedRef} mobile={false} />
      </div>
    </div>,
    document.body,
  );
}

function MobileCommands({ commands, selectedIndex, onSelect }: Omit<CommandPopoverProps, 'anchorRef'>) {
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Like the mention sheet: driven by the composer text, so the backdrop does not intercept taps.
  return createPortal(
    <>
      <div className="fixed inset-0 z-[300] bg-black/30 pointer-events-none" />
      <div
        className="fixed left-0 right-0 z-[301] rounded-t-2xl glass-modal animate-slide-up-sheet flex flex-col"
        style={{
          bottom: 'var(--keyboard-inset)',
          paddingBottom: 'var(--safe-bottom)',
          maxHeight: 'min(calc(50*var(--app-dvh)), calc(50*var(--app-vh)))',
        }}
      >
        <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1 shrink-0" />
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          <CommandList commands={commands} selectedIndex={selectedIndex} onSelect={onSelect} selectedRef={selectedRef} mobile />
        </div>
      </div>
    </>,
    document.body,
  );
}

export function CommandPopover({ commands, selectedIndex, onSelect, anchorRef }: CommandPopoverProps) {
  const isMobile = useUIStore((s) => s.isMobile);
  if (commands.length === 0) return null;
  if (isMobile) {
    return (
      <MobileCommands
        commands={commands}
        selectedIndex={selectedIndex}
        onSelect={onSelect}
      />
    );
  }

  return (
    <DesktopCommands
      commands={commands}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      anchorRef={anchorRef}
    />
  );
}
