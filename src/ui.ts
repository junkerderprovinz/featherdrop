import { t } from '@/src/i18n';

// The warning shake of a field or button, started over when it is still running.
export function shake(el: Element | null | undefined) {
  if (!el) return;
  el.classList.remove('glim-shake');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('glim-shake');
}

/** How long content takes to move or fade at the motion level in use, in milliseconds, and 0 when the system or
 * the settings ask for no motion. */
export function contentTime(): number {
  if (document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--motion-content-dur').trim();
  return value.endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000 || 0;
}

/** Brings the top of the page into view, where the castle stands. */
export function toTop() {
  scrollTo({ top: 0, behavior: contentTime() ? 'smooth' : 'instant' });
}

export const eyeWords = () => ({ show: t('common.show'), hide: t('common.hide') });
export const copyWords = () => ({ copy: t('common.copy'), copied: t('common.copied') });
export const windowWords = () => ({ cancel: t('common.cancel'), close: t('common.close') });
