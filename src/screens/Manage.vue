<script setup lang="ts">
// The page behind the management link: how long the share lives and what it
// has left, and the one way to end it early. The token comes from the
// fragment, which the browser never sends to the server.
import { Button, Card, EmptyState, FieldRow } from '@glimstone/vue';
import { computed, ref } from 'vue';
import { HttpError } from '@/lib/e2e/http-error';
import { manageTokenFromFragment, revokeShare } from '@/lib/e2e/manage-link';
import { confirm } from '@/src/confirm';
import { dateTime, size, wait } from '@/src/format';
import { glyph } from '@/src/glyphs';
import { num, t } from '@/src/i18n';
import { follow, route } from '@/src/router';
import { toast } from '@/src/toast';

const slug = route.parts[1] ?? '';
const token = manageTokenFromFragment(location.hash);
const phase = ref<'loading' | 'ready' | 'deleted' | 'notfound'>(token ? 'loading' : 'notfound');
const meta = ref<{ size: number; expiresAt: number | null; downloadsLeft: number | null } | null>(null);
const busy = ref(false);

if (token) {
  fetch(`/api/d/${encodeURIComponent(slug)}/meta`).then(
    async (res) => {
      if (!res.ok) return void (phase.value = 'notfound');
      meta.value = await res.json();
      phase.value = 'ready';
    },
    () => (phase.value = 'notfound'),
  );
}

const expires = computed(() => (meta.value?.expiresAt == null ? t('done.neverExpires') : dateTime(meta.value.expiresAt)));

async function remove() {
  if (!(await confirm(t('manage.deleteQuestion'), { confirmLabel: t('manage.delete'), confirmLabelKey: 'IconTrash' }))) return;
  busy.value = true;
  try {
    phase.value = (await revokeShare(slug, token)) === 'deleted' ? 'deleted' : 'notfound';
    if (phase.value === 'deleted') toast(t('manage.deleted'));
  } catch (e) {
    const why = e instanceof HttpError && e.status === 429 ? wait(e.retryAfter) : '';
    toast(`${t('manage.deleteFailed')} ${why}`.trim(), 'fail');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section v-if="phase === 'deleted' || phase === 'notfound'" class="cp-narrow" data-cp="manage-end">
    <EmptyState
      :glyph="glyph(phase === 'deleted' ? 'IconTrash' : 'IconUnlink')"
      :title="phase === 'deleted' ? t('manage.deletedTitle') : t('manage.notFoundTitle')"
      :hint="phase === 'deleted' ? t('manage.deletedText') : t('manage.notFoundText')"
    >
      <Button :label="t('gone.send')" label-key="IconUpload" href="/" @click="follow($event, '/')" />
    </EmptyState>
  </section>
  <section v-else class="cp-column">
    <Card :title="t('manage.title')">
      <template v-if="meta">
        <FieldRow :label="t('manage.size')" :value="size(meta.size)" />
        <FieldRow :label="t('manage.expires')" :value="expires" />
        <FieldRow :label="t('manage.left')" :value="meta.downloadsLeft === null ? t('manage.unlimited') : num(meta.downloadsLeft)" />
      </template>
      <FieldRow :label="t('manage.end')" :hint="t('manage.deleteHint')">
        <Button :label="t('manage.delete')" label-key="IconTrash" :busy="busy" :disabled="phase === 'loading'" data-cp="delete" @click="remove" />
      </FieldRow>
    </Card>
  </section>
</template>
