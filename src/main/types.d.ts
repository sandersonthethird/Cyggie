// Ambient type declarations for the main bundle.
//
// `*.md?raw` is Vite's built-in raw-content suffix. electron-vite uses Vite for
// the main bundle, so the suffix works at build time — but TypeScript needs a
// declaration to know the module type.

declare module '*.md?raw' {
  const content: string
  export default content
}

declare module '*.txt?raw' {
  const content: string
  export default content
}

interface ImportMetaEnv {
  readonly DEV: boolean
  readonly PROD: boolean
  readonly MAIN_VITE_SHARE_SECRET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
