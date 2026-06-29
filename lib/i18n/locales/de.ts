import type { Translation } from "./en.ts";

export const de: Translation = {
  "app.tagline": "Teile deine Dateien sicher und ohne Datenschutzbedenken",
  "app.subtitle": "Ende-zu-Ende verschlüsselt — der Server sieht deine Dateien nie. Wird automatisch gelöscht.",
  "app.privacy": "Ende-zu-Ende verschlüsselt · automatische Löschung · kein Tracking · kein Kontozwang · kein Scheiß",
  "theme.toggle": "Design umschalten",
  "language.label": "Sprache",


  "insecure.warning": "Unsichere Verbindung (HTTP). Große Uploads und Stream-Downloads sind eingeschränkt. Öffne diese Seite über HTTPS für den vollen Funktionsumfang.",
  "drop.drag": "Datei zum Hochladen hierher ziehen",
  "drop.browse": "oder klicken zum Auswählen",
  "drop.replace": "andere Datei ablegen zum Ersetzen",
  "drop.replaceMulti": "erneut ablegen zum Ersetzen",
  "drop.fileCount": "Dateien: {{count}}",
  "drop.total": "Gesamt: {{size}}",

  "settings.title": "Download-Optionen",
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

  "result.manageTitle": "Verwaltungslink",
  "result.manageHint": "Privat halten — damit kannst du die Freigabe vor Ablauf löschen.",
  "result.copyManage": "Verwaltungslink kopieren",
  "manage.title": "Freigabe verwalten",
  "manage.loading": "Freigabe wird geprüft…",
  "manage.intro": "Beim Löschen werden Datei und Link sofort entfernt. Das lässt sich nicht rückgängig machen.",
  "manage.delete": "Jetzt löschen",
  "manage.confirmDelete": "Zum Bestätigen erneut klicken",
  "manage.deleted": "Freigabe gelöscht",
  "manage.deleteFailed": "Löschen fehlgeschlagen",
  "manage.notFound": "Dieser Verwaltungslink ist ungültig oder die Freigabe ist bereits abgelaufen oder gelöscht.",
  "download.protected": "Diese Datei ist passwortgeschützt",
  "download.passwordPlaceholder": "Passwort eingeben",
  "download.unlock": "Entsperren & herunterladen",
  "download.download": "Datei herunterladen",
  "download.wrongPassword": "Falsches Passwort",
  "download.failed": "Download fehlgeschlagen",

  "download.encryptedFile": "Verschlüsselte Datei",

  "download.downloadsLeft": "Verbleibende Downloads: {{count}}",

  "download.missingKey": "Diesem Link fehlt der Entschlüsselungs-Schlüssel — er wurde vielleicht unvollständig kopiert.",
  "download.multiFile": "Verschlüsselte Dateien",
  "download.fileCount": "Dateien: {{count}}",
  "download.total": "Gesamt: {{size}}",
  "download.downloadAll": "Alle herunterladen",
  "download.saveToFolder": "In Ordner speichern",

  "preview.show": "Vorschau",
  "preview.hide": "Vorschau ausblenden",
  "preview.tooLarge": "Zu groß für eine Vorschau — zum Ansehen herunterladen",

  "notfound.title": "Hier ist nichts",
  "notfound.body": "Dieser Link ist ungültig oder die Datei ist abgelaufen und wurde entfernt.",
  "notfound.share": "Datei teilen",

  "upload.failed": "Upload fehlgeschlagen",
  "upload.finalizeFailed": "Freigabe konnte nicht abgeschlossen werden",
  "upload.encrypting": "Verschlüsselung läuft…",

  "uploadGate.title": "Diese Instanz erfordert ein Upload-Passwort",
  "uploadGate.password": "Upload-Passwort",
  "uploadGate.placeholder": "Upload-Passwort eingeben",
  "uploadGate.unlock": "Upload freischalten",
  "uploadGate.wrongPassword": "Falsches Upload-Passwort",

  "expiry.1h": "1 Stunde",
  "expiry.6h": "6 Stunden",
  "expiry.1d": "1 Tag",
  "expiry.7d": "7 Tagen",
  "expiry.30d": "30 Tagen",
  "expiry.never": "Nie",

  "relexp.never": "Läuft nie ab",
  "relexp.expired": "Abgelaufen",
  "relexp.minutes": "Läuft ab in {{count}} Min",
  "relexp.hours": "Läuft ab in {{count}} Std",
  "relexp.days": "Läuft ab in {{count}} Tagen",
};
