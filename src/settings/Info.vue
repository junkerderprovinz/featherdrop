<script setup lang="ts">
import { COFFEE_BUTTON_SVG, GLIMSTONE_VERSION, MAIL_SVG, type VersionRow } from '@glimstone/core';
import { BrandMark, InfoAboutCard, InfoHelpCard, InfoVersionCard } from '@glimstone/vue';
import { computed, h, ref, type FunctionalComponent } from 'vue';
import { glyph } from '@/src/glyphs';
import GiveWindow from '@/src/gs-gaps/GiveWindow.vue';
import { t } from '@/src/i18n';
import { toast } from '@/src/toast';
import { windowWords } from '@/src/ui';
import { version } from '@/package.json';

// The page cannot ask GitHub for updates, since its policy lets it talk to its own server alone.
const REPO = 'https://github.com/junkerderprovinz/castleparcel';

const versions = computed<VersionRow[]>(() => [
  { name: 'CastleParcel', version, repoUrl: REPO },
  { name: 'GlimStone', version: GLIMSTONE_VERSION, repoUrl: 'https://github.com/junkerderprovinz/glimstone' },
]);

const svgMark = (svg: string): FunctionalComponent => () => h(BrandMark, { svg });
const coffeeArt = svgMark(COFFEE_BUTTON_SVG);
const mailGlyph = svgMark(MAIL_SVG);

type Route = 'coffee' | 'paypal' | 'crypto';
const giving = ref<Route | null>(null);
const ROUTES: Record<Route, { title: string; text: string; url: string; glyph: string }> = {
  coffee: { title: 'info.coffeeButton', text: 'info.coffeeText', url: 'https://buymeacoffee.com/junkerderprovinz', glyph: 'IconCoffee' },
  paypal: { title: 'info.paypal', text: 'info.paypalText', url: 'https://www.paypal.com/donate/?hosted_button_id=76FVV52TKXTUS', glyph: 'IconPayPal' },
  crypto: { title: 'info.crypto', text: 'info.cryptoText', url: 'https://junkerderprovinz.github.io/junkerderprovinz/', glyph: 'IconBitcoin' },
};

const releaseNotes = () => window.open(`${REPO}/releases/tag/v${version}`, '_blank', 'noopener');

function bugReport() {
  const report = JSON.stringify({ app: 'CastleParcel', version, userAgent: navigator.userAgent, secureContext: isSecureContext }, null, 2);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([report], { type: 'application/json' })), download: 'castleparcel-bug-report.json' });
  a.click();
  URL.revokeObjectURL(a.href);
  toast(t('info.bugSaved'));
}
</script>

<template>
  <InfoVersionCard :rows="versions" :text="{ title: t('info.version'), hint: t('info.versionHint'), unreleased: (v) => t('info.unreleased', { v }), releaseNotes: t('info.releaseNotes') }" :on-release-notes="releaseNotes" />
  <InfoHelpCard :repo-url="REPO" :repo-glyph="glyph('IconGithub')" mail-address="hello@halleluja.design" :mail-glyph="mailGlyph" :bug-glyph="glyph('IconDiagnostics')" :on-bug-report="bugReport"
    :text="{ title: t('info.help'), report: t('info.report'), repoButton: t('info.repo'), mailButton: t('info.mail'), mailSubject: t('info.mailSubject'), bugReport: t('info.bug'), bugReportSub: t('info.bugSub') }" />
  <InfoAboutCard :coffee-art="coffeeArt" :paypal-glyph="glyph('IconPayPal')" :crypto-glyph="glyph('IconBitcoin')"
    :on-coffee="() => (giving = 'coffee')" :on-paypal="() => (giving = 'paypal')" :on-crypto="() => (giving = 'crypto')"
    :text="{ title: t('info.about'), body: t('info.body'), coffee: t('info.coffee'), coffeeButton: t('info.coffeeButton'), paypalButton: t('info.paypal'), cryptoButton: t('info.crypto') }" />
  <GiveWindow v-if="giving" :title="t(ROUTES[giving].title)" :appeal="t('info.appeal')" :text="t(ROUTES[giving].text)" :go="t('info.open')" :url="ROUTES[giving].url" :glyph-key="ROUTES[giving].glyph" :words="windowWords()" @close="giving = null" />
</template>
