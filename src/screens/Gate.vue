<script setup lang="ts">
// With UPLOAD_PASSWORD set, the castle asks before anyone sends. The server
// never sends the secret, so a wrong one shows only once an upload is refused,
// and then this gate comes back with the reason.
import { Button, Card, FieldRow, PasswordField } from '@glimstone/vue';
import { ref } from 'vue';
import AppMark from '@/src/components/AppMark.vue';
import { t } from '@/src/i18n';
import { eyeWords, shake } from '@/src/ui';
import { gate, unlockUploads } from '@/src/upload';

const password = ref('');
const empty = ref(false);
const field = ref<InstanceType<typeof PasswordField> | null>(null);

function unlock() {
  empty.value = !password.value.trim();
  if (!empty.value) return unlockUploads(password.value.trim());
  shake(field.value?.input);
  field.value?.input?.select();
}
</script>

<template>
  <section class="cp-narrow">
    <div class="cp-mark-small"><AppMark :size="150" /></div>
    <Card :title="t('gate.title')">
      <form class="cp-form" novalidate @submit.prevent="unlock">
        <p class="cp-text">{{ t('gate.text') }}</p>
        <FieldRow :label="t('gate.password')">
          <PasswordField ref="field" v-model="password" width="medium" autocomplete="current-password" :text="eyeWords()" data-cp="gate-password" />
        </FieldRow>
        <p v-if="empty || gate.error" class="cp-error" role="alert">{{ empty ? t('gate.empty') : gate.error }}</p>
        <div class="cp-actions">
          <Button size="key" tone="accent" type="submit" :label="t('gate.unlock')" label-key="IconUnlock" data-cp="gate-unlock" />
        </div>
      </form>
    </Card>
  </section>
</template>
