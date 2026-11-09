<script setup lang="ts">
// The other forms of CastleParcel as the README's download buttons. The phone app does not exist yet, so its buttons
// stand as placeholders, as in the other apps of the house.
import { DOCKER_SVG, FDROID_SVG, PLAY_SVG, ANDROID_SVG, UNRAID_SVG, ZIP_SVG, type ReadmeBrand, type ReadmePart } from '@glimstone/core';
import { BrandMark, Card, ReadmeButton } from '@glimstone/vue';
import { computed } from 'vue';
import { t } from '@/src/i18n';

interface Build { brand: ReadmeBrand; parts: [ReadmePart, ...ReadmePart[]]; svg: string; markClass?: string }
const REPO = 'https://github.com/junkerderprovinz/castleparcel';

const cards = computed(() => [
  { title: 'builds.server', hint: 'builds.serverHint', builds: [
    { brand: 'unraid', svg: UNRAID_SVG, parts: [{ name: 'Unraid', href: 'https://ca.unraid.net/' }] },
    { brand: 'docker', svg: DOCKER_SVG, markClass: 'glim-docker-mark', parts: [{ name: 'Docker', href: 'https://hub.docker.com/r/junkerderprovinz/castleparcel' }] },
    { brand: 'zip', svg: ZIP_SVG, parts: [{ name: t('builds.source'), href: REPO + '/releases/latest' }] },
  ] as Build[] },
  { title: 'builds.phone', hint: 'builds.phoneHint', builds: [
    { brand: 'play', svg: PLAY_SVG, parts: [{ name: 'Google Play' }] },
    { brand: 'fdroid', svg: FDROID_SVG, parts: [{ name: 'F-Droid' }] },
    { brand: 'android', svg: ANDROID_SVG, markClass: 'glim-android-mark', parts: [{ name: 'Android' }] },
  ] as Build[] },
]);
</script>

<template>
  <Card v-for="card in cards" :key="card.title" :title="t(card.title)" :hint="t(card.hint)">
    <div class="glim-readme-btn-rows">
      <ReadmeButton v-for="b in card.builds" :key="b.brand" :brand="b.brand" :parts="b.parts" :mark-class="b.markClass" :soon-label="t('builds.soon')">
        <template #mark><BrandMark :svg="b.svg" /></template>
      </ReadmeButton>
    </div>
  </Card>
</template>
