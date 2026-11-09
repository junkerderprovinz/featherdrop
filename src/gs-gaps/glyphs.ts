// Marks CastleParcel needs that GlimStone's assortment lacks, drawn on its 14 unit grid with filled shapes.
export const GAP_GLYPHS: Record<string, { viewBox: string; svg: string }> = {
  IconQrCode: {
    viewBox: '0 0 14 14',
    svg: '<path fill-rule="evenodd" clip-rule="evenodd" d="M1.5 0h3A1.5 1.5 0 0 1 6 1.5v3A1.5 1.5 0 0 1 4.5 6h-3A1.5 1.5 0 0 1 0 4.5v-3A1.5 1.5 0 0 1 1.5 0Zm.25 1.75v2.5h2.5v-2.5Zm7.75-1.75h3A1.5 1.5 0 0 1 14 1.5v3A1.5 1.5 0 0 1 12.5 6h-3A1.5 1.5 0 0 1 8 4.5v-3A1.5 1.5 0 0 1 9.5 0Zm.25 1.75v2.5h2.5v-2.5ZM1.5 8h3A1.5 1.5 0 0 1 6 9.5v3A1.5 1.5 0 0 1 4.5 14h-3A1.5 1.5 0 0 1 0 12.5v-3A1.5 1.5 0 0 1 1.5 8Zm.25 1.75v2.5h2.5v-2.5Z"/><rect x="8" y="8" width="2.5" height="2.5" rx=".6"/><rect x="11.5" y="8" width="2.5" height="2.5" rx=".6"/><rect x="8" y="11.5" width="2.5" height="2.5" rx=".6"/><rect x="11.5" y="11.5" width="2.5" height="2.5" rx=".6"/>',
  },
  IconFolderSave: {
    viewBox: '0 0 14 14',
    svg: '<path d="M1.5 1h3.6a1.5 1.5 0 0 1 1.2.6l.9 1.2h5.3A1.5 1.5 0 0 1 14 4.3v7.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 0 11.5v-9A1.5 1.5 0 0 1 1.5 1Zm4.7 4.2v2.6H4.6a.4.4 0 0 0-.28.68l2.4 2.4a.4.4 0 0 0 .56 0l2.4-2.4a.4.4 0 0 0-.28-.68H7.8V5.2a.8.8 0 0 0-1.6 0Z"/>',
  },
};
