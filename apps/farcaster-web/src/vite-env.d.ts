/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly RELEASE_ID: string;
  /** "on" in a build that also runs the host's picture proxy (`server/img/`). */
  readonly VITE_IMAGE_PROXY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
