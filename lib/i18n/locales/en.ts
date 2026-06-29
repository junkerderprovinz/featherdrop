// English is the source of truth: its key set defines TranslationKey, and every
// other locale must provide exactly these keys (enforced at compile time via the
// Translation type and at runtime by test/locales.test.ts).
//
// Interpolation uses i18next syntax: {{label}}, {{count}}.
export const en = {
  "app.tagline": "Share your files securely and privately",
  "app.subtitle": "End-to-end encrypted — the server never sees your files. Deleted automatically.",
  "app.privacy": "End-to-end encrypted · auto-deleted · no tracking · no account · no bullshit",
  "theme.toggle": "Toggle theme",
  "language.label": "Language",


  "insecure.warning": "Insecure connection (HTTP). Large uploads and streamed downloads are limited. Open this page over HTTPS for full functionality.",
  "drop.drag": "Drag a file here to upload",
  "drop.browse": "or click to choose one",
  "drop.replace": "drop another file to replace it",
  "drop.replaceMulti": "drop again to replace",
  "drop.fileCount": "Files: {{count}}",
  "drop.total": "Total: {{size}}",

  "settings.title": "Download options",
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
  "result.downloadQr": "Save QR code",
  "result.neverExpires": "Never expires",
  "result.expiresAfter": "Expires after {{label}}",

  "download.protected": "This file is password-protected",
  "download.passwordPlaceholder": "Enter password",
  "download.unlock": "Unlock & download",
  "download.download": "Download file",
  "download.wrongPassword": "Wrong password",
  "download.failed": "Download failed",
  "download.encryptedFile": "Encrypted file",
  "download.downloadsLeft": "Downloads left: {{count}}",
  "download.missingKey": "This link is missing its decryption key — it may have been copied incompletely.",
  "download.multiFile": "Encrypted files",
  "download.fileCount": "Files: {{count}}",
  "download.total": "Total: {{size}}",
  "download.downloadAll": "Download all",
  "download.saveToFolder": "Save to folder",

  "preview.show": "Preview",
  "preview.hide": "Hide preview",
  "preview.tooLarge": "Too large to preview — download to view it",

  "notfound.title": "Nothing here",
  "notfound.body": "This link is invalid, or the file has expired and been removed.",
  "notfound.share": "Share a file",

  "upload.failed": "Upload failed",
  "upload.finalizeFailed": "Could not finalize share",
  "upload.encrypting": "Encrypting…",

  "uploadGate.title": "This instance requires an upload password",
  "uploadGate.password": "Upload password",
  "uploadGate.placeholder": "Enter the upload password",
  "uploadGate.unlock": "Unlock uploading",
  "uploadGate.wrongPassword": "Wrong upload password",

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
