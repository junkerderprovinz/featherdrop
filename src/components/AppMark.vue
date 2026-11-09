<script setup lang="ts">
// The castle stands for the app wherever its name does, unless the server brought a logo of its own.
import { config } from '@/src/config';
import CastleLoader from '@/src/loaderStub.vue';

defineProps<{ size: number; mode?: 'idle' | 'upload' | 'download'; progress?: number | null }>();
</script>

<template>
  <img v-if="config.branding.logoUrl" class="cp-logo" :src="config.branding.logoUrl" :width="size" :height="size" alt="">
  <CastleLoader v-else :mode="mode ?? 'idle'" :progress="progress ?? null" :size="size" />
</template>
