import type { Translation } from "./en.ts";

export const de: Translation = {
  "app.tagline": "Teile eine Datei sicher — ganz ohne Konto.",
  "app.subtitle": "Verschlüsselt gespeichert und automatisch gelöscht, sobald der Link abläuft.",
  "theme.toggle": "Design umschalten",
  "language.label": "Sprache",

  "drop.drag": "Datei zum Hochladen hierher ziehen",
  "drop.browse": "oder klicken zum Auswählen",
  "drop.replace": "andere Datei ablegen zum Ersetzen",

  "settings.title": "Freigabe-Optionen",
  "settings.expiresAfter": "Läuft ab nach",
  "settings.password": "Passwort (optional)",
  "settings.passwordPlaceholder": "Leer lassen für keins",
  "settings.limitDownloads": "Download-Limit",
  "settings.maxDownloads": "Max. Downloads",
  "settings.upload": "Hochladen & teilen",

  "result.ready": "Dein Link ist bereit",
  "result.copy": "Link kopieren",
  "result.copied": "Kopiert",

  "result.copyFailed": "Kopieren fehlgeschlagen — Link markieren und manuell kopieren.",
  "result.shareAnother": "Weitere Datei teilen",
  "result.downloadQr": "QR-Code speichern",
  "result.neverExpires": "Läuft nie ab",
  "result.expiresAfter": "Läuft ab nach {{label}}",

  "download.protected": "Diese Datei ist passwortgeschützt",
  "download.passwordPlaceholder": "Passwort eingeben",
  "download.unlock": "Entsperren & herunterladen",
  "download.download": "Datei herunterladen",
  "download.wrongPassword": "Falsches Passwort",
  "download.failed": "Download fehlgeschlagen",

  "download.encryptedFile": "Verschlüsselte Datei",

  "download.downloadsLeft": "Verbleibende Downloads: {{count}}",

  "download.missingKey": "Diesem Link fehlt der Entschlüsselungs-Schlüssel — er wurde vielleicht unvollständig kopiert.",

  "notfound.title": "Hier ist nichts",
  "notfound.body": "Dieser Link ist ungültig oder die Datei ist abgelaufen und wurde entfernt.",
  "notfound.share": "Datei teilen",

  "upload.failed": "Upload fehlgeschlagen",
  "upload.finalizeFailed": "Freigabe konnte nicht abgeschlossen werden",

  "expiry.1h": "1 Stunde",
  "expiry.6h": "6 Stunden",
  "expiry.1d": "1 Tag",
  "expiry.7d": "7 Tage",
  "expiry.30d": "30 Tage",
  "expiry.never": "Nie",

  "relexp.never": "Läuft nie ab",
  "relexp.expired": "Abgelaufen",
  "relexp.minutes": "Läuft ab in {{count}} Min",
  "relexp.hours": "Läuft ab in {{count}} Std",
  "relexp.days": "Läuft ab in {{count}} Tagen",
};
