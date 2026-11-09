<script setup lang="ts">
// A QR code for a link, drawn dark on a white tile in every theme, since phone cameras read it best that way, and
// saved as a PNG at four times its size so it prints sharp.
import { Button } from '@glimstone/vue';
import qrcode from 'qrcode-generator';
import { computed } from 'vue';

const props = defineProps<{ value: string; label: string; saveLabel: string; fileName: string }>();
const emit = defineEmits<{ saved: [] }>();

const QUIET = 2;
const code = computed(() => {
  const qr = qrcode(0, 'M');
  qr.addData(props.value);
  qr.make();
  return qr;
});
const cells = computed(() => code.value.getModuleCount() + QUIET * 2);
const path = computed(() => {
  const n = code.value.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (code.value.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1Z`;
  return d;
});

function save() {
  const scale = 16, px = cells.value * scale;
  const canvas = Object.assign(document.createElement('canvas'), { width: px, height: px });
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, px, px);
  g.fillStyle = '#000000';
  g.scale(scale, scale);
  g.fill(new Path2D(path.value));
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: props.fileName });
    a.click();
    URL.revokeObjectURL(a.href);
    emit('saved');
  }, 'image/png');
}
</script>

<template>
  <div class="gs-qr">
    <svg class="gs-qr-code" :viewBox="`0 0 ${cells} ${cells}`" role="img" :aria-label="label" shape-rendering="crispEdges"><rect :width="cells" :height="cells" fill="#fff" /><path :d="path" fill="#000" /></svg>
    <Button :label="saveLabel" label-key="IconDownload" @click="save" />
  </div>
</template>

<style scoped>
.gs-qr { display: flex; flex-direction: column; align-items: center; gap: .75rem; }
.gs-qr-code { width: 11rem; height: 11rem; border-radius: var(--radius-control); }
</style>
