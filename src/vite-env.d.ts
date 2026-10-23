/**
 * Ambient declarations for Vite-resolved asset imports. TypeScript 6 emits
 * TS2882 for side-effect style imports that lack a module declaration;
 * Vite's bundler resolves these `.css` specifiers at build time.
 */
declare module '*.css'
