/// <reference types="vite/client" />

// Build id injected by Vite's `define` (see vite.config.ts). Changes every
// build; the same value is served from /version.json for update detection.
declare const __BUILD_ID__: string;

// The "what's new" list this bundle was built with (/whatsnew.json).
declare const __WHATS_NEW__: import("./whatsNew").WhatsNewEntry[];
