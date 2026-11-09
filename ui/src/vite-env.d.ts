/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

// Injected at build time by vite.config.ts (define:).
declare const __APP_VERSION__: string
declare const __COMMIT_SHA__: string

// One page per released version, built by vite.config.ts from the changelogs (konclave-release-pages).
declare module 'virtual:konclave-releases' {
  type ReleaseBlock = { k: 'h' | 'h3' | 'p' | 'note'; t: string } | { k: 'ul'; items: string[] }
  const pages: { version: string; date: string; blocks: ReleaseBlock[] }[]
  export default pages
}
