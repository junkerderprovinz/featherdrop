import type { Translation } from "./en.ts";

export const sv: Translation = {
  "app.tagline": "Dela dina filer säkert och privat",
  "app.subtitle": "Totalsträckskrypterat — servern ser aldrig dina filer. Raderas automatiskt.",
  "app.privacy": "Totalsträckskryptering · automatisk radering · ingen spårning · inget konto · inget skitsnack",
  "theme.toggle": "Växla tema",
  "language.label": "Språk",


  "insecure.warning": "Osäker anslutning (HTTP). Stora uppladdningar och strömmade nedladdningar är begränsade. Öppna sidan via HTTPS för full funktionalitet.",
  "drop.drag": "Dra en fil hit",
  "drop.browse": "eller klicka för att bläddra",
  "drop.replace": "släpp en annan för att ersätta",
  "drop.replaceMulti": "släpp igen för att ersätta",
  "drop.fileCount": "Filer: {{count}}",
  "drop.total": "Totalt: {{size}}",

  "settings.title": "Nedladdningsalternativ",
  "settings.expiresAfter": "Går ut efter",
  "settings.password": "Lösenord (valfritt)",
  "settings.passwordPlaceholder": "Lämna tomt för inget",
  "settings.limitDownloads": "Begränsa nedladdningar",
  "settings.maxDownloads": "Max nedladdningar",
  "settings.upload": "Ladda upp och dela",

  "result.ready": "Redo att dela",
  "result.copy": "Kopiera länk",
  "result.copied": "Kopierat",

  "result.copyFailed": "Kunde inte kopiera — markera länken och kopiera manuellt.",
  "result.shareAnother": "Dela en annan fil",
  "result.downloadQr": "Spara QR-kod",
  "result.neverExpires": "Går aldrig ut",
  "result.expiresAfter": "Går ut efter {{label}}",

  "download.protected": "Den här filen är lösenordsskyddad",
  "download.passwordPlaceholder": "Ange lösenord",
  "download.unlock": "Lås upp och ladda ner",
  "download.download": "Ladda ner",
  "download.wrongPassword": "Fel lösenord",
  "download.failed": "Nedladdningen misslyckades",

  "download.encryptedFile": "Krypterad fil",
  "download.downloadsLeft": "Återstående nedladdningar: {{count}}",

  "download.missingKey": "Den här länken saknar sin dekrypteringsnyckel — den kan ha kopierats ofullständigt.",
  "download.multiFile": "Krypterade filer",
  "download.fileCount": "Filer: {{count}}",
  "download.total": "Totalt: {{size}}",
  "download.downloadAll": "Ladda ner alla",
  "download.saveToFolder": "Spara till mapp",

  "preview.show": "Förhandsvisning",
  "preview.hide": "Dölj förhandsvisning",
  "preview.tooLarge": "För stor för förhandsvisning — ladda ner för att visa den",

  "notfound.title": "Inget här",
  "notfound.body": "Den här länken är ogiltig, eller så har filen gått ut och tagits bort.",
  "notfound.share": "Dela en fil",

  "upload.failed": "Uppladdningen misslyckades",
  "upload.finalizeFailed": "Kunde inte slutföra delningen",
  "upload.encrypting": "Krypterar…",

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
