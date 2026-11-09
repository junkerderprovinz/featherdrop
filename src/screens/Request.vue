<script setup lang="ts">
// Opens a file request and hands out its two links: the request link for
// whoever sends, the collect link for the requester alone.
import { Button, Card, CopyField, FieldRow, NumberField, Selector, UnavailableNotice } from '@glimstone/vue';
import { Select } from '@glimstone/vue/Select';
import { computed, reactive, ref } from 'vue';
import { createRequest } from '@/lib/e2e/request-flow';
import { cryptoWorker } from '@/lib/e2e/v2/crypto-worker';
import { baseUrl } from '@/src/config';
import { t } from '@/src/i18n';
import { go } from '@/src/router';
import Gate from '@/src/screens/Gate.vue';
import { toast } from '@/src/toast';
import { copyWords } from '@/src/ui';
import { explainUpload, expiryChoices, gate, refusal, startExpiry, uploadLocked } from '@/src/upload';

const MB = 1000 * 1000;

const form = reactive({ expiry: startExpiry(), uploads: 'none' as 'none' | 'count', maxUploads: 5, size: 'none' as 'none' | 'count', maxMb: 100 });
const busy = ref(false);
const error = ref('');
const links = ref<{ requestUrl: string; collectUrl: string } | null>(null);

const expiries = computed(() => expiryChoices().map((e) => ({ value: e, label: t('expiry.' + e) })));
const choices = computed(() => [
  { id: 'none' as const, label: t('request.noLimit') },
  { id: 'count' as const, label: t('request.setLimit') },
]);
const maxUploads = computed({ get: () => form.maxUploads, set: (v: number | null) => { form.maxUploads = v ?? 1; } });
const maxMb = computed({ get: () => form.maxMb, set: (v: number | null) => { form.maxMb = v ?? 1; } });

async function create() {
  busy.value = true;
  error.value = '';
  try {
    links.value = await createRequest(
      {
        expiry: form.expiry,
        maxUploads: form.uploads === 'count' ? Math.max(1, Math.floor(form.maxUploads)) : null,
        maxSize: form.size === 'count' ? Math.max(1, form.maxMb) * MB : null,
      },
      { baseUrl: baseUrl(), crypto: cryptoWorker, uploadToken: gate.token },
    );
    toast(t('request.created'));
  } catch (e) {
    const status = refusal(e)?.status;
    error.value = status === 401 || status === 429 ? explainUpload(e) : t('request.failed');
  } finally {
    busy.value = false;
  }
}

const openCollect = () => go(new URL(links.value!.collectUrl).pathname + new URL(links.value!.collectUrl).hash);
</script>

<template>
  <Gate v-if="uploadLocked()" />
  <section v-else class="cp-column">
    <Card :title="t('request.title')" :hint="t('request.intro')">
      <UnavailableNotice :title="t('request.warning')" />
      <template v-if="links">
        <FieldRow class="cp-gap-top" :label="t('request.requestLink')" :hint="t('request.requestLinkHint')" />
        <CopyField :value="links.requestUrl" :label="t('request.requestLink')" width="fill" :text="copyWords()" data-cp="request-link" />
        <FieldRow class="cp-gap-top" :label="t('request.collectLink')" :hint="t('request.collectLinkHint')">
          <Button :label="t('request.openCollect')" label-key="IconExternalLink" data-cp="open-collect" @click="openCollect" />
        </FieldRow>
        <CopyField :value="links.collectUrl" :label="t('request.collectLink')" width="fill" :text="copyWords()" data-cp="collect-link" />
      </template>
    </Card>
    <template v-if="!links">
      <Card :title="t('options.options')">
        <FieldRow :label="t('request.expiry')" :hint="t('request.expiryHint')">
          <Select v-model="form.expiry" :options="expiries" list-id="cp-request-expiry" />
        </FieldRow>
        <FieldRow :label="t('request.maxUploads')" :hint="t('request.maxUploadsHint')">
          <Selector v-model="form.uploads" :items="choices" size="sm" activation="manual" inline button-height />
        </FieldRow>
        <FieldRow v-if="form.uploads === 'count'" :label="t('request.maxUploads')">
          <NumberField v-model="maxUploads" />
        </FieldRow>
        <FieldRow :label="t('request.maxSize')" :hint="t('request.maxSizeHint')">
          <Selector v-model="form.size" :items="choices" size="sm" activation="manual" inline button-height />
        </FieldRow>
        <FieldRow v-if="form.size === 'count'" :label="t('request.maxSize')">
          <NumberField v-model="maxMb" />
        </FieldRow>
      </Card>
      <p v-if="error" class="cp-error" role="alert">{{ error }}</p>
      <div class="cp-actions">
        <Button size="key" tone="accent" :busy="busy" :label="t('request.create')" label-key="IconAdd" data-cp="create-request" @click="create" />
      </div>
    </template>
  </section>
</template>
