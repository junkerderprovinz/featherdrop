<script setup lang="ts">
// The bar over every page: the way back at the start of the line, the way into Settings at its end. The start page
// needs no way back, and its castle stands for the app.
import { Button } from '@glimstone/vue';
import { computed, ref, watchEffect } from 'vue';
import { t } from '@/src/i18n';
import { follow, go, route } from '@/src/router';

const props = defineProps<{ screen: string }>();
const inSettings = computed(() => props.screen === 'settings');

// Settings leads back to where the person came from, every other page to the start page.
const before = ref('/');
watchEffect(() => {
  if (route.parts[0] !== 'settings') before.value = location.pathname + location.hash;
});
const back = computed(() => (inSettings.value ? before.value : '/'));
</script>

<template>
  <header class="cp-head">
    <Button v-if="screen !== 'home'" :label="t('app.back')" label-key="IconBack" :href="back" data-cp="back" @click="follow($event, back)" />
    <span class="cp-spacer"></span>
    <Button v-if="!inSettings" variant="icon" :label="t('app.settings')" label-key="IconGear" data-cp="settings" @click="go('/settings/general')" />
  </header>
</template>
