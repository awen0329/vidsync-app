/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_KEY?: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_CLOUD_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
