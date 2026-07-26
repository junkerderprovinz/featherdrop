/// <reference types="vite/client" />

// Ambient declarations for Vite's non-code imports (CSS side-effect imports in
// src/main.tsx, plus any static assets). Vite resolves these at build time;
// TypeScript needs the declaration to type the bare `import "...styles.css"`
// statements. TS 7 is stricter than TS 5 here and now errors (TS2882) on a
// side-effect import that has no module declaration.
