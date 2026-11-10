// The steps of a parcel that share the start page's address, the options, the upload and the link, each hold an
// entry in the browser's history, so Back and Forward, from the toolbar or a mouse's side buttons, move between them
// as between pages.
import { confirm } from '@/src/confirm';
import { t } from '@/src/i18n';
import { toast } from '@/src/toast';
import { cancelUpload, openOptions, resetSend, send } from '@/src/upload';

type Step = 'files' | 'upload' | 'link';

const current = (): Step | undefined => history.state?.cp;

function mark(step: Step | null, add = false) {
  const state = step ? { cp: step } : null;
  if (add) history.pushState(state, '', location.pathname);
  else history.replaceState(state, '', location.pathname);
}

/** Asks before stopping the upload, as its cancel button does. */
export async function askToCancel() {
  if (!(await confirm(t('upload.cancelQuestion'), { confirmLabel: t('upload.cancel'), confirmLabelKey: 'IconStop' }))) return;
  if (send.stage !== 'uploading') return;
  await cancelUpload();
  toast(t('upload.cancelled'), 'warn');
}

/** Keeps the history in step with the parcel: opening the options adds an entry, the upload and the link take it over. */
export function followStage(stage: typeof send.stage) {
  if (stage === 'options') mark('files', current() !== 'files' && current() !== 'upload');
  else if (stage === 'uploading') mark('upload', !current());
  else if (stage === 'done' && send.sent) mark('link');
  else if (stage === 'home' && current()) mark(null);
}

/** The way back from the options or the link, through the history when they hold an entry there. */
export function leaveStep() {
  if (current()) history.back();
  else resetSend();
}

/** Answers a move through the history while the start page shows. */
export function onHistory() {
  const step = current();
  if (send.stage === 'uploading') {
    if (step !== 'upload') {
      mark('upload', true);
      void askToCancel();
    }
  } else if (step === 'files') {
    if (send.stage === 'home') openOptions();
  } else if (!step) {
    if (send.stage === 'options' || send.stage === 'done') resetSend();
  } else if (step === 'link' && send.stage !== 'done') {
    // A link that is gone cannot be shown again.
    mark(null);
  }
}
