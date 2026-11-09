import { t } from '@/src/i18n';

// The warning shake of a field or button, started over when it is still running.
export function shake(el: Element | null | undefined) {
  if (!el) return;
  el.classList.remove('glim-shake');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('glim-shake');
}

export const eyeWords = () => ({ show: t('common.show'), hide: t('common.hide') });
export const copyWords = () => ({ copy: t('common.copy'), copied: t('common.copied') });
export const windowWords = () => ({ cancel: t('common.cancel'), close: t('common.close') });
