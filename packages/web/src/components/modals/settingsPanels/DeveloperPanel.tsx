import { useTranslation } from 'react-i18next';
import { Toggle } from '../../ui/Toggle';
import { useDeveloperModeStore } from '../../../stores/developerModeStore';

export function DeveloperPanel() {
  const { t } = useTranslation(['settings']);
  const enabled = useDeveloperModeStore((s) => s.enabled);
  const setEnabled = useDeveloperModeStore((s) => s.setEnabled);

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">{t('settings:developer.title')}</h2>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
        <div className="flex items-center justify-between py-1">
          <div className="flex-1 mr-4">
            <div className="text-sm text-txt-primary">{t('settings:developer.mode.label')}</div>
            <div className="text-xs text-txt-tertiary mt-0.5">{t('settings:developer.mode.description')}</div>
          </div>
          <Toggle enabled={enabled} onChange={setEnabled} ariaLabel={t('settings:developer.mode.label')} />
        </div>
      </div>
    </div>
  );
}
