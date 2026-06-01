import type { Translation } from "./en.ts";

export const pl: Translation = {
  "app.tagline": "Upuść plik, udostępnij link.",
  "app.subtitle": "Zaszyfrowane i znika po wygaśnięciu.",
  "theme.toggle": "Przełącz motyw",
  "language.label": "Język",

  "drop.drag": "Przeciągnij plik tutaj",
  "drop.browse": "lub kliknij, aby wybrać",
  "drop.replace": "upuść inny, aby zastąpić",

  "settings.title": "Opcje udostępniania",
  "settings.expiresAfter": "Wygasa po",
  "settings.password": "Hasło (opcjonalne)",
  "settings.passwordPlaceholder": "Pozostaw puste, aby brak",
  "settings.limitDownloads": "Ogranicz pobrania",
  "settings.maxDownloads": "Maks. pobrań",
  "settings.upload": "Prześlij i udostępnij",

  "result.ready": "Gotowe do udostępnienia",
  "result.copy": "Kopiuj link",
  "result.copied": "Skopiowano",

  "result.copyFailed": "Nie udało się skopiować — zaznacz link i skopiuj ręcznie.",
  "result.shareAnother": "Udostępnij kolejny plik",
  "result.neverExpires": "Nigdy nie wygasa",
  "result.expiresAfter": "Wygasa po {{label}}",

  "download.protected": "Ten plik jest chroniony hasłem",
  "download.passwordPlaceholder": "Wprowadź hasło",
  "download.unlock": "Odblokuj i pobierz",
  "download.download": "Pobierz",
  "download.wrongPassword": "Błędne hasło",
  "download.failed": "Pobieranie nie powiodło się",

  "download.encryptedFile": "Zaszyfrowany plik",
  "download.downloadsLeft": "Pozostałe pobrania: {{count}}",

  "download.missingKey": "Temu linkowi brakuje klucza deszyfrującego — mógł zostać skopiowany niekompletnie.",

  "notfound.title": "Tu nic nie ma",
  "notfound.body": "Ten link jest nieprawidłowy lub plik wygasł i został usunięty.",
  "notfound.share": "Udostępnij plik",

  "upload.failed": "Przesyłanie nie powiodło się",
  "upload.finalizeFailed": "Nie udało się sfinalizować udostępniania",

  "expiry.1h": "1 godzina",
  "expiry.6h": "6 godzin",
  "expiry.1d": "1 dzień",
  "expiry.7d": "7 dni",
  "expiry.30d": "30 dni",
  "expiry.never": "Nigdy",

  "relexp.never": "Nigdy nie wygasa",
  "relexp.expired": "Wygasło",
  "relexp.minutes": "Wygasa za {{count}} min",
  "relexp.hours": "Wygasa za {{count}} godz.",
  "relexp.days": "Wygasa za {{count}} dni",
};
