/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute URL to the contact API (default: /api/contact). */
  readonly VITE_CONTACT_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
