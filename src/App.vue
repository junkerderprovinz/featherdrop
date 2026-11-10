<script setup lang="ts">
import { UnavailableNotice } from '@glimstone/vue';
import { computed, watchEffect } from 'vue';
import ToastHost from '@/src/components/ToastHost.vue';
import TopBar from '@/src/components/TopBar.vue';
import { config, insecure } from '@/src/config';
import { ConfirmHost } from '@/src/confirm';
import { t } from '@/src/i18n';
import { dragging, picked, setInput } from '@/src/intake';
import { route } from '@/src/router';
import Collect from '@/src/screens/Collect.vue';
import Manage from '@/src/screens/Manage.vue';
import NotFound from '@/src/screens/NotFound.vue';
import Receive from '@/src/screens/Receive.vue';
import SendTo from '@/src/screens/SendTo.vue';
import Sender from '@/src/screens/Sender.vue';
import Settings from '@/src/settings/Settings.vue';

// The routes that take a slug name it as their second part. A note and a request open under the castle of the start
// page, so those three share one screen that stays put while the castle moves.
const SCREENS = { '': Sender, d: Receive, m: Manage, note: Sender, request: Sender, r: SendTo, c: Collect, settings: Settings } as const;
const name = computed(() => route.parts[0] ?? '');
const screen = computed(() => SCREENS[name.value as keyof typeof SCREENS] ?? NotFound);
const inSettings = computed(() => name.value === 'settings');
const screenKey = computed(() => (screen.value === Sender ? 'home' : route.parts.slice(0, inSettings.value ? 1 : 2).join('/')));

watchEffect(() => {
  document.title = config.branding.appName;
});
</script>

<template>
  <div class="cp" :data-screen="name || 'home'">
    <TopBar :screen="name || 'home'" />
    <UnavailableNotice v-if="insecure" class="cp-insecure" :title="t('insecure.title')">{{ t('insecure.text') }}</UnavailableNotice>
    <main class="cp-main">
      <component :is="screen" :key="screenKey" class="glim-page-enter" />
    </main>
    <div v-if="dragging" class="cp-dropzone" aria-hidden="true" data-cp="dropzone"></div>
    <input :ref="setInput" type="file" multiple hidden data-cp="files" @change="picked">
    <ToastHost />
    <ConfirmHost />
  </div>
</template>
