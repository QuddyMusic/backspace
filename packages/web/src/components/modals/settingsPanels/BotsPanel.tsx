import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BotSummary } from '@backspace/shared';
import { BOT_NAME_MAX_LENGTH, BOT_NAME_MIN_LENGTH, MAX_BOTS_PER_USER } from '@backspace/shared/src/constants';
import { api } from '../../../api/client';
import { describeError } from '../../../i18n/errors';
import { useFormatters } from '../../../i18n/formatters';

interface RevealedToken {
  username: string;
  token: string;
}

const buttonClass =
  'px-3 py-1.5 rounded-md text-sm bg-interactive-selected text-txt-primary hover:bg-interactive-hover transition-colors disabled:opacity-50';
const quietButtonClass =
  'px-3 py-1.5 rounded-md text-sm text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover transition-colors disabled:opacity-50';
const dangerButtonClass =
  'px-3 py-1.5 rounded-md text-sm text-txt-danger hover:bg-accent-rose/10 transition-colors disabled:opacity-50';

export function BotsPanel() {
  const { t } = useTranslation(['settings']);
  const { formatMediumDate } = useFormatters();
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.bots.list();
      setBots(res.bots);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.bots.create({ name });
      setBots((prev) => [...prev, res.bot]);
      setRevealed({ username: res.bot.username, token: res.token });
      setCopied(false);
      setName('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerate = async (bot: BotSummary) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.bots.regenerateToken(bot.id);
      setRevealed({ username: bot.username, token: res.token });
      setCopied(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (bot: BotSummary) => {
    setBusy(true);
    setError(null);
    try {
      await api.bots.delete(bot.id);
      setBots((prev) => prev.filter((b) => b.id !== bot.id));
      setConfirmDeleteId(null);
      setRevealed((prev) => (prev?.username === bot.username ? null : prev));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = () => {
    if (!revealed) return;
    navigator.clipboard
      .writeText(revealed.token)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-2">{t('settings:bots.title')}</h2>
      <p className="text-sm text-txt-tertiary">{t('settings:bots.description')}</p>

      {error && (
        <div className="rounded-lg bg-accent-rose/10 border border-accent-rose/20 p-3 text-sm text-txt-danger">
          {error}
        </div>
      )}

      {revealed && (
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-2">
          <div className="text-sm font-medium text-txt-primary">
            {t('settings:bots.token.title', { name: revealed.username })}
          </div>
          <div className="text-xs text-txt-tertiary">{t('settings:bots.token.warning')}</div>
          <code className="block break-all rounded-md bg-surface-input p-2 text-xs text-txt-primary select-all">
            {revealed.token}
          </code>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} onClick={handleCopy}>
              {copied ? t('settings:bots.token.copied') : t('settings:bots.token.copy')}
            </button>
            <button type="button" className={quietButtonClass} onClick={() => setRevealed(null)}>
              {t('settings:bots.token.dismiss')}
            </button>
          </div>
        </div>
      )}

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('settings:bots.create.sectionTitle')}
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-2">
          <label className="block text-sm text-txt-primary" htmlFor="bot-name">
            {t('settings:bots.create.nameLabel')}
          </label>
          <div className="flex gap-2">
            <input
              id="bot-name"
              className="input-standard flex-1 min-w-0"
              value={name}
              maxLength={BOT_NAME_MAX_LENGTH}
              autoComplete="off"
              onChange={(e) => setName(e.target.value.toLowerCase())}
            />
            <button
              type="button"
              className={buttonClass}
              disabled={busy || name.trim().length === 0}
              onClick={() => void handleCreate()}
            >
              {t('settings:bots.create.submit')}
            </button>
          </div>
          <div className="text-xs text-txt-tertiary">
            {t('settings:bots.create.hint', {
              min: BOT_NAME_MIN_LENGTH,
              max: BOT_NAME_MAX_LENGTH,
              limit: MAX_BOTS_PER_USER,
            })}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('settings:bots.list.sectionTitle')}
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-3">
          {!loading && bots.length === 0 && (
            <div className="text-sm text-txt-tertiary">{t('settings:bots.list.empty')}</div>
          )}
          {bots.map((bot) => (
            <div key={bot.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-txt-primary truncate">{bot.displayName || bot.username}</div>
                <div className="text-xs text-txt-tertiary truncate">
                  @{bot.username} · {t('settings:bots.list.createdOn', { date: formatMediumDate(bot.createdAt) })}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button type="button" className={quietButtonClass} disabled={busy} onClick={() => void handleRegenerate(bot)}>
                  {t('settings:bots.actions.regenerate')}
                </button>
                {confirmDeleteId === bot.id ? (
                  <>
                    <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => void handleDelete(bot)}>
                      {t('settings:bots.actions.confirmDelete')}
                    </button>
                    <button type="button" className={quietButtonClass} onClick={() => setConfirmDeleteId(null)}>
                      {t('settings:bots.actions.cancel')}
                    </button>
                  </>
                ) : (
                  <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => setConfirmDeleteId(bot.id)}>
                    {t('settings:bots.actions.delete')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
