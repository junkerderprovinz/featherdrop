// Short notes in the corner, through GlimStone's queue, so pointing at one holds it.
import { addToast, pauseToast, removeToast, resumeToast, type ToastEntry, type ToastSeverity } from '@glimstone/core';
import { ref } from 'vue';
import { prefs } from '@/src/prefs';

export const toasts = ref<ToastEntry[]>([]);
let next = 1;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function arm(entry: ToastEntry) {
  clearTimeout(timers.get(entry.id));
  if (entry.expiresAt !== null) timers.set(entry.id, setTimeout(() => dismiss(entry.id), entry.expiresAt - Date.now()));
}

export function toast(message: string, severity: ToastSeverity = 'success') {
  // Quiet notifications drop routine confirmations; anything that went wrong still shows.
  if (prefs.quiet && severity === 'success') return;
  toasts.value = addToast(toasts.value, { id: String(next++), message, severity }, Date.now());
  toasts.value.forEach(arm);
}

export function dismiss(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts.value = removeToast(toasts.value, id);
}
export function hold(id: string) {
  clearTimeout(timers.get(id));
  toasts.value = pauseToast(toasts.value, id, Date.now());
}
export function release(id: string) {
  toasts.value = resumeToast(toasts.value, id, Date.now());
  const entry = toasts.value.find((x) => x.id === id);
  if (entry) arm(entry);
}
