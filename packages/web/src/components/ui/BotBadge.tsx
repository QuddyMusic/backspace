import React from 'react';
import { useTranslation } from 'react-i18next';

interface BotBadgeProps {
  className?: string;
}

export function BotBadge({ className = '' }: BotBadgeProps) {
  const { t } = useTranslation('common');

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border-2 border-accent-lavender text-accent-lavender leading-none ${className}`}
    >
      {t('actions.bot')}
    </span>
  );
}
