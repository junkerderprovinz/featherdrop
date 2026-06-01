import type { Translation } from "./en.ts";

export const sv: Translation = {
  "app.tagline": "Släpp en fil, dela en länk.",
  "app.subtitle": "Krypterat, och borta när det går ut.",
  "theme.toggle": "Växla tema",
  "language.label": "Språk",

  "drop.drag": "Dra en fil hit",
  "drop.browse": "eller klicka för att bläddra",
  "drop.replace": "släpp en annan för att ersätta",

  "settings.title": "Delningsalternativ",
  "settings.expiresAfter": "Går ut efter",
  "settings.password": "Lösenord (valfritt)",
  "settings.passwordPlaceholder": "Lämna tomt för inget",
  "settings.limitDownloads": "Limit downloads",
  "settings.maxDownloads": "Max downloads",
  "settings.upload": "Ladda upp och dela",

  "result.ready": "Redo att dela",
  "result.copy": "Kopiera länk",
  "result.copied": "Kopierat",

  "result.copyFailed": "Kunde inte kopiera — markera länken och kopiera manuellt.",
  "result.shareAnother": "Dela en annan fil",
  "result.neverExpires": "Går aldrig ut",
  "result.expiresAfter": "Går ut efter {{label}}",

  "download.protected": "Den här filen är lösenordsskyddad",
  "download.passwordPlaceholder": "Ange lösenord",
  "download.unlock": "Lås upp och ladda ner",
  "download.download": "Ladda ner",
  "download.wrongPassword": "Fel lösenord",
  "download.failed": "Nedladdningen misslyckades",

  "download.encryptedFile": "Krypterad fil",
  "download.downloadsLeft": "{{count}} downloads left",

  "download.missingKey": "Den här länken saknar sin dekrypteringsnyckel — den kan ha kopierats ofullständigt.",

  "notfound.title": "Inget här",
  "notfound.body": "Den här länken är ogiltig, eller så har filen gått ut och tagits bort.",
  "notfound.share": "Dela en fil",

  "upload.failed": "Uppladdningen misslyckades",
  "upload.finalizeFailed": "Kunde inte slutföra delningen",

  "expiry.1h": "1 timme",
  "expiry.6h": "6 timmar",
  "expiry.1d": "1 dag",
  "expiry.7d": "7 dagar",
  "expiry.30d": "30 dagar",
  "expiry.never": "Aldrig",

  "relexp.never": "Går aldrig ut",
  "relexp.expired": "Utgången",
  "relexp.minutes": "Går ut om {{count}} min",
  "relexp.hours": "Går ut om {{count}} h",
  "relexp.days": "Går ut om {{count}} dagar",
};
