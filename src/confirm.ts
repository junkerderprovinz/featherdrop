import { useConfirm } from '@glimstone/vue';
import { t } from '@/src/i18n';

// The words are read when a question opens, so they follow a change of language.
export const { confirm, ConfirmHost } = useConfirm({
  get title() { return t('common.confirm'); },
  get cancel() { return t('common.cancel'); },
  get confirm() { return t('common.confirm'); },
});
