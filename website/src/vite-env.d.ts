/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_ADMIN_HASHES: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
