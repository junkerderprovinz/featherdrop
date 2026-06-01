import type { Translation } from "./en.ts";

export const it: Translation = {
  "app.tagline": "Rilascia un file, condividi un link.",
  "app.subtitle": "Cifrato, e sparisce alla scadenza.",
  "theme.toggle": "Cambia tema",
  "language.label": "Lingua",

  "drop.drag": "Trascina qui un file",
  "drop.browse": "o clicca per sfogliare",
  "drop.replace": "rilasciane un altro per sostituire",

  "settings.title": "Opzioni di condivisione",
  "settings.expiresAfter": "Scade dopo",
  "settings.password": "Password (facoltativa)",
  "settings.passwordPlaceholder": "Lascia vuoto per nessuna",
  "settings.upload": "Carica e condividi",

  "result.ready": "Pronto per la condivisione",
  "result.copy": "Copia link",
  "result.copied": "Copiato",

  "result.copyFailed": "Copia non riuscita — seleziona il link e copialo manualmente.",
  "result.shareAnother": "Condividi un altro file",
  "result.neverExpires": "Non scade mai",
  "result.expiresAfter": "Scade dopo {{label}}",

  "download.protected": "Questo file è protetto da password",
  "download.passwordPlaceholder": "Inserisci la password",
  "download.unlock": "Sblocca e scarica",
  "download.download": "Scarica",
  "download.wrongPassword": "Password errata",
  "download.failed": "Download non riuscito",

  "download.encryptedFile": "File cifrato",

  "download.missingKey": "A questo link manca la chiave di decifratura — forse è stato copiato in modo incompleto.",

  "notfound.title": "Qui non c'è niente",
  "notfound.body": "Questo link non è valido, oppure il file è scaduto ed è stato rimosso.",
  "notfound.share": "Condividi un file",

  "upload.failed": "Caricamento non riuscito",
  "upload.finalizeFailed": "Impossibile finalizzare la condivisione",

  "expiry.1h": "1 ora",
  "expiry.6h": "6 ore",
  "expiry.1d": "1 giorno",
  "expiry.7d": "7 giorni",
  "expiry.30d": "30 giorni",
  "expiry.never": "Mai",

  "relexp.never": "Non scade mai",
  "relexp.expired": "Scaduto",
  "relexp.minutes": "Scade tra {{count}} min",
  "relexp.hours": "Scade tra {{count}} h",
  "relexp.days": "Scade tra {{count}} giorni",
};
