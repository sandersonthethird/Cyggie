// Ambient type declarations for the renderer bundle.

// CSS Modules — Vite handles these at build time; TypeScript needs a
// declaration so imports type-check. Each export is the resolved class name
// (string). Some files in the codebase predate this declaration and silently
// `as any` it; this file gives them proper types.
declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}

// Vite raw imports (for embedded text resources like markdown).
declare module '*.md?raw' {
  const content: string
  export default content
}
