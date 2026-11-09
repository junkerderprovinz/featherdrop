<script setup lang="ts">
import { Button, UnavailableNotice } from '@glimstone/vue';
import { computed, watchEffect } from 'vue';
import AppMark from '@/src/components/AppMark.vue';
import ToastHost from '@/src/components/ToastHost.vue';
import { config, insecure } from '@/src/config';
import { ConfirmHost } from '@/src/confirm';
import { t } from '@/src/i18n';
import { picked, setInput } from '@/src/intake';
import { follow, go, route } from '@/src/router';
import Collect from '@/src/screens/Collect.vue';
import Manage from '@/src/screens/Manage.vue';
import NotFound from '@/src/screens/NotFound.vue';
import Note from '@/src/screens/Note.vue';
import Receive from '@/src/screens/Receive.vue';
import Request from '@/src/screens/Request.vue';
import SendTo from '@/src/screens/SendTo.vue';
import Sender from '@/src/screens/Sender.vue';
import Settings from '@/src/settings/Settings.vue';

// The routes that take a slug name it as their second part.
const SCREENS = { '': Sender, d: Receive, m: Manage, note: Note, request: Request, r: SendTo, c: Collect, settings: Settings } as const;
const name = computed(() => route.parts[0] ?? '');
const screen = computed(() => SCREENS[name.value as keyof typeof SCREENS] ?? NotFound);
const inSettings = computed(() => name.value === 'settings');

// The way back from Settings leads to where the person came from.
let before = '/';
watchEffect(() => {
  if (!inSettings.value) before = location.pathname + location.hash;
});
const back = () => go(before);

watchEffect(() => {
  document.title = config.branding.appName;
});
</script>

<template>
  <div class="cp" :data-screen="name || 'home'">
    <header class="cp-head">
      <a class="cp-brand" href="/" @click="follow($event, '/')"><AppMark :size="34" /><span class="cp-brand-name">{{ config.branding.appName }}</span></a>
      <span class="cp-spacer"></span>
      <Button v-if="inSettings" :label="t('app.back')" label-key="IconBack" data-cp="back" @click="back" />
      <Button v-else variant="icon" :label="t('app.settings')" label-key="IconGear" data-cp="settings" @click="go('/settings/general')" />
    </header>
    <UnavailableNotice v-if="insecure" class="cp-insecure" :title="t('insecure.title')">{{ t('insecure.text') }}</UnavailableNotice>
    <main class="cp-main">
      <component :is="screen" :key="route.parts.slice(0, inSettings ? 1 : 2).join('/')" class="glim-page-enter" />
    </main>
    <input :ref="setInput" type="file" multiple hidden data-cp="files" @change="picked">
    <ToastHost />
    <ConfirmHost />
  </div>
</template>
