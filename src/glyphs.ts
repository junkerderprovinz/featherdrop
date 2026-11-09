// Glyphs by name from GlimStone's assortment and the few drawn here, and which one a file gets by its kind.
import coreGlyphs from '@glimstone/core/glyphs.json';
import { setGlyphResolver } from '@glimstone/vue';
import { type FunctionalComponent, h } from 'vue';
import { GAP_GLYPHS } from '@/src/gs-gaps/glyphs';

type Glyph = { viewBox: string; svg: string };
const GLYPHS: Record<string, Glyph> = {
  ...Object.fromEntries((coreGlyphs as (Glyph & { name: string })[]).map((g) => [g.name, { viewBox: g.viewBox, svg: g.svg.replace(/\s+/g, ' ') }])),
  ...GAP_GLYPHS,
};

// Glyphs that point along the line of text, which a right to left page mirrors.
const ALONG = new Set(['IconBack', 'IconForward']);

export const G: FunctionalComponent<{ n: string }> = ({ n }) => {
  const d = GLYPHS[n] ?? GLYPHS.IconFile!;
  return h('svg', { viewBox: d.viewBox, fill: 'currentColor', 'aria-hidden': 'true', class: ALONG.has(n) ? 'glyph-flip' : undefined, innerHTML: d.svg });
};
G.props = ['n'];

const components = new Map<string, FunctionalComponent>();
export function glyph(name: string): FunctionalComponent {
  if (!components.has(name)) components.set(name, () => h(G, { n: name }));
  return components.get(name)!;
}

// A button's label key is the name of its glyph, so the same verb wears the same mark everywhere.
export const installGlyphs = () => setGlyphResolver((key) => (GLYPHS[key] ? glyph(key) : undefined));

export type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'svg' | 'sheet' | 'archive' | 'file';
const KINDS: Record<string, Kind> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', heic: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio',
  pdf: 'pdf', txt: 'text', md: 'text', log: 'text', json: 'text', csv: 'text', svg: 'svg',
  xlsx: 'sheet', ods: 'sheet', zip: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
};
export const kindOf = (name: string): Kind => KINDS[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'file';

const KIND_GLYPH: Record<Kind, string> = {
  image: 'IconFileImage', video: 'IconFileVideo', audio: 'IconFileAudio', pdf: 'IconFilePdf', text: 'IconFileText',
  svg: 'IconFileDesign', sheet: 'IconFileSheet', archive: 'IconArchive', file: 'IconFile',
};
export const fileGlyph = (name: string) => KIND_GLYPH[kindOf(name)];
export const previewable = (name: string) => ['image', 'video', 'audio', 'pdf', 'text', 'svg'].includes(kindOf(name));
