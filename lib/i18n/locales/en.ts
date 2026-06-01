// English is the source of truth: its key set defines TranslationKey, and every
// other locale must provide exactly these keys (enforced at compile time via the
// Translation type and at runtime by test/locales.test.ts).
//
// Interpolation uses i18next syntax: {{label}}, {{count}}.
export const en = {
  "app.tagline": "Share a file securely — no account needed.",
  "app.subtitle": "Encrypted at rest and automatically deleted when the link expires.",
  "theme.toggle": "Toggle theme",
  "language.label": "Language",

  "drop.drag": "Drag a file here to upload",
  "drop.browse": "or click to choose one",
  "drop.replace": "drop another file to replace it",

  "settings.title": "Share options",
  "settings.expiresAfter": "Expires after",
  "settings.password": "Password (optional)",
  "settings.passwordPlaceholder": "Leave empty for none",
  "settings.limitDownloads": "Limit downloads",
  "settings.maxDownloads": "Max downloads",
  "settings.upload": "Upload & share",

  "result.ready": "Your link is ready",
  "result.copy": "Copy link",
  "result.copied": "Copied",
  "result.copyFailed": "Could not copy — select the link and copy it manually.",
  "result.shareAnother": "Share another file",
  "result.neverExpires": "Never expires",
  "result.expiresAfter": "Expires after {{label}}",

  "download.protected": "This file is password-protected",
  "download.passwordPlaceholder": "Enter password",
  "download.unlock": "Unlock & download",
  "download.download": "Download file",
  "download.wrongPassword": "Wrong password",
  "download.failed": "Download failed",
  "download.encryptedFile": "Encrypted file",
  "download.downloadsLeft": "{{count}} downloads left",
  "download.missingKey": "This link is missing its decryption key — it may have been copied incompletely.",

  "notfound.title": "Nothing here",
  "notfound.body": "This link is invalid, or the file has expired and been removed.",
  "notfound.share": "Share a file",

  "upload.failed": "Upload failed",
  "upload.finalizeFailed": "Could not finalize share",

  "expiry.1h": "1 hour",
  "expiry.6h": "6 hours",
  "expiry.1d": "1 day",
  "expiry.7d": "7 days",
  "expiry.30d": "30 days",
  "expiry.never": "Never",

  "relexp.never": "Never expires",
  "relexp.expired": "Expired",
  "relexp.minutes": "Expires in {{count}} min",
  "relexp.hours": "Expires in {{count}} h",
  "relexp.days": "Expires in {{count}} days",
} as const;

export type TranslationKey = keyof typeof en;
export type Translation = Record<TranslationKey, string>;
