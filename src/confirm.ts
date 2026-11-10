import { useConfirm } from '@glimstone/vue';
import { t } from '@/src/i18n';

// The words are read when a question opens, so they follow a change of language. The way out says Back, because one
// question offers to cancel an upload and a Cancel beside that button would leave unclear which one does it.
export const { confirm, ConfirmHost } = useConfirm({
  get title() { return t('common.confirm'); },
  get cancel() { return t('app.back'); },
  get confirm() { return t('common.confirm'); },
});
