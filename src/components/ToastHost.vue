<script setup lang="ts">
import { ToastViewport } from '@glimstone/vue';
import { t } from '@/src/i18n';
import { dismiss, hold, release, toasts } from '@/src/toast';
</script>

<template>
  <ToastViewport :toasts="toasts" :dismiss-label="t('common.close')" @dismiss="dismiss" @enter="hold" @leave="release" @focusin="hold" @focusout="release" />
</template>
