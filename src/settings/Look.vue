<script setup lang="ts">
import { oledRefusal } from '@glimstone/core';
import { Card, FieldRow, Selector, Toggle } from '@glimstone/vue';
import { Select } from '@glimstone/vue/Select';
import { computed, type FunctionalComponent, h } from 'vue';
import AccentSwatches from '@/src/gs-gaps/AccentSwatches.vue';
import { glyph } from '@/src/glyphs';
import { language, languages, setLanguage, t } from '@/src/i18n';
import { prefs } from '@/src/prefs';

const FLAGS = import.meta.glob<string>('../../node_modules/flag-icons/flags/4x3/{cz,dk,de,gb,es,fr,it,hu,nl,no,pl,pt,ro,fi,se,vn,tr,gr,ru,ua,il,sa,th,kr,cn,jp}.svg', { eager: true, query: '?url', import: 'default' });
const flagOf = (code: string) => Object.entries(FLAGS).find(([path]) => path.endsWith(`/${code}.svg`))?.[1];
const flag = (code: string): FunctionalComponent => () => h('img', { class: 'cp-flag', src: flagOf(code), alt: '' });

const lang = computed({ get: language, set: setLanguage });
const langs = computed(() => languages().map((l) => ({ value: l.code, label: l.name, glyph: flag(l.flag) })));

type Choice<V> = [V, string, string];
const seg = <V extends string>(list: Choice<V>[]) => list.map(([id, key, g]) => ({ id, label: t('look.' + key), glyph: glyph(g) }));
const themes = computed(() => seg<typeof prefs.theme>([['dark', 'dark', 'IconMoon'], ['light', 'light', 'IconSun'], ['system', 'system', 'IconThemeSystem']]));
const shapes = computed(() => seg([['round', 'round', 'IconCornerRound'], ['soft', 'soft', 'IconCornerSoft'], ['square', 'square', 'IconCornerSquare']]));
const motions = computed(() => seg([['off', 'off', 'IconMotionOff'], ['subtle', 'subtle', 'IconMotionSubtle'], ['wild', 'wild', 'IconMotionWild']]));
const labelModes = computed(() => seg<typeof prefs.labelsButtons>([['text', 'text', 'IconLabelText'], ['textGlyph', 'textGlyph', 'IconLabelTextGlyph'], ['glyph', 'glyph', 'IconLabelGlyph'], ['reactive', 'reactive', 'IconLabelReactive']]));

const refused = computed(() => oledRefusal(prefs.theme, { sentence: t('oled.refusal'), dark: t('look.dark'), system: t('look.system'), light: t('look.light') }));
</script>

<template>
  <Card :title="t('look.display')">
    <FieldRow :label="t('look.language')"><Select v-model="lang" :options="langs" list-id="cp-languages" /></FieldRow>
    <FieldRow :label="t('look.theme')" :hint="t('look.themeHint')"><Selector v-model="prefs.theme" :items="themes" size="sm" activation="manual" inline button-height pairs-on-phone /></FieldRow>
    <FieldRow :label="t('look.oled')" :hint="t('look.oledHint')"><Toggle v-model="prefs.oled" :refused="refused" /></FieldRow>
    <FieldRow :label="t('look.corners')" :hint="t('look.cornersHint')"><Selector v-model="prefs.shape" :items="shapes" size="sm" activation="manual" inline button-height pairs-on-phone /></FieldRow>
    <FieldRow :label="t('look.motion')" :hint="t('look.motionHint')"><Selector v-model="prefs.motion" :items="motions" size="sm" activation="manual" inline button-height pairs-on-phone /></FieldRow>
    <FieldRow :label="t('look.buttons')" :hint="t('look.buttonsHint')"><Selector v-model="prefs.labelsButtons" :items="labelModes" size="sm" activation="manual" inline button-height pairs-on-phone /></FieldRow>
  </Card>
  <Card :title="t('look.colours')">
    <FieldRow :label="t('look.accent')" :hint="t('look.accentHint')">
      <AccentSwatches v-model="prefs.accent" :disabled="prefs.rainbow" :name="(n) => t('look.preset', { n })" />
    </FieldRow>
    <FieldRow :label="t('look.rainbow')" :hint="t('look.rainbowHint')"><Toggle v-model="prefs.rainbow" /></FieldRow>
    <FieldRow v-if="prefs.rainbow" :label="t('look.reactiveMode')" :hint="t('look.reactiveHint')"><Toggle v-model="prefs.reactive" /></FieldRow>
  </Card>
</template>
