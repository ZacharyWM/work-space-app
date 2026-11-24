// vite's ambient types: makes asset imports (styles.css, step 4.3) typecheck
/// <reference types="vite/client" />

// build-time env the client reads (notes/005); set in client/.env.local
interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
}
