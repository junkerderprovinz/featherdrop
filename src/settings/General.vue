<script setup lang="ts">
import { Card, FieldRow, Toggle } from '@glimstone/vue';
import { Select } from '@glimstone/vue/Select';
import { computed } from 'vue';
import { t } from '@/src/i18n';
import { prefs } from '@/src/prefs';
import { expiryChoices, startExpiry } from '@/src/upload';

const expiries = computed(() => expiryChoices().map((e) => ({ value: e, label: t('expiry.' + e) })));
const expiry = computed({ get: startExpiry, set: (v: string) => { prefs.defaultExpiry = v; } });
</script>

<template>
  <Card :title="t('general.sending')">
    <FieldRow :label="t('general.remember')" :hint="t('general.rememberHint')"><Toggle v-model="prefs.remember" /></FieldRow>
    <!-- Remembered choices make the defaults below meaningless, so they only show while nothing is remembered. -->
    <template v-if="!prefs.remember">
      <FieldRow :label="t('general.expiry')" :hint="t('general.expiryHint')"><Select v-model="expiry" :options="expiries" list-id="cp-default-expiry" /></FieldRow>
      <FieldRow :label="t('general.metadata')" :hint="t('general.metadataHint')"><Toggle v-model="prefs.stripMetadata" /></FieldRow>
    </template>
    <FieldRow :label="t('general.paste')" :hint="t('general.pasteHint')"><Toggle v-model="prefs.paste" /></FieldRow>
  </Card>
  <Card :title="t('general.feedback')">
    <FieldRow :label="t('general.quiet')" :hint="t('general.quietHint')"><Toggle v-model="prefs.quiet" /></FieldRow>
    <FieldRow :label="t('general.celebrate')" :hint="t('general.celebrateHint')"><Toggle v-model="prefs.celebrate" /></FieldRow>
  </Card>
</template>
