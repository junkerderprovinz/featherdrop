<script setup lang="ts">
// Settings: a column of tiles beside the content, the tab selector turned on its side. General comes first, then
// Appearance, as in every app of the house, and Info last.
import { Selector } from '@glimstone/vue';
import { computed } from 'vue';
import { glyph } from '@/src/glyphs';
import { t } from '@/src/i18n';
import { go, route } from '@/src/router';
import Apps from './Apps.vue';
import General from './General.vue';
import Info from './Info.vue';
import Look from './Look.vue';

const TABS = [
  { id: 'general', g: 'IconTabGeneral', component: General },
  { id: 'look', g: 'IconTabLook', component: Look },
  { id: 'app', g: 'IconTabApp', component: Apps },
  { id: 'info', g: 'IconInfo', component: Info },
] as const;
type Tab = (typeof TABS)[number]['id'];

const current = computed(() => TABS.find((x) => x.id === route.parts[1]) ?? TABS[0]);
const items = computed(() => TABS.map((x) => ({ id: x.id as Tab, label: t('settings.tabs.' + x.id), glyph: glyph(x.g), href: '/settings/' + x.id })));
const tab = computed({ get: () => current.value.id as Tab, set: (id: Tab) => go('/settings/' + id) });
</script>

<template>
  <div class="cp-settings">
    <Selector v-model="tab" class="cp-tiles" :items="items" orientation="vertical" activation="manual" :label="t('settings.title')" panel-id="cp-settings-body" />
    <div id="cp-settings-body" class="cp-settings-body" role="tabpanel">
      <component :is="current.component" :key="current.id" />
    </div>
  </div>
</template>
