import type { Translation } from "./en.ts";

export const uk: Translation = {
  "app.tagline": "Перетягніть файл, поділіться посиланням.",
  "app.subtitle": "Зашифровано та зникає після завершення.",
  "app.privacy": "Шифрування · автовидалення · без стеження · без фігні",
  "theme.toggle": "Перемкнути тему",
  "language.label": "Мова",

  "drop.drag": "Перетягніть файл сюди",
  "drop.browse": "або натисніть для вибору",
  "drop.replace": "перетягніть інший для заміни",

  "settings.title": "Параметри доступу",
  "settings.expiresAfter": "Спливає через",
  "settings.password": "Пароль (необов’язково)",
  "settings.passwordPlaceholder": "Залиште порожнім, щоб без пароля",
  "settings.limitDownloads": "Обмежити завантаження",
  "settings.maxDownloads": "Макс. завантажень",
  "settings.upload": "Завантажити та поділитися",

  "result.ready": "Готово до надсилання",
  "result.copy": "Копіювати посилання",
  "result.copied": "Скопійовано",

  "result.copyFailed": "Не вдалося скопіювати — виділіть посилання та скопіюйте вручну.",
  "result.shareAnother": "Поділитися іншим файлом",
  "result.downloadQr": "Зберегти QR-код",
  "result.neverExpires": "Ніколи не спливає",
  "result.expiresAfter": "Спливає через {{label}}",

  "download.protected": "Цей файл захищено паролем",
  "download.passwordPlaceholder": "Введіть пароль",
  "download.unlock": "Розблокувати та завантажити",
  "download.download": "Завантажити",
  "download.wrongPassword": "Неправильний пароль",
  "download.failed": "Не вдалося завантажити",

  "download.encryptedFile": "Зашифрований файл",
  "download.downloadsLeft": "Залишилося завантажень: {{count}}",

  "download.missingKey": "У цьому посиланні немає ключа розшифрування — можливо, його скопійовано не повністю.",

  "notfound.title": "Тут нічого немає",
  "notfound.body": "Це посилання недійсне, або файл сплив і його видалено.",
  "notfound.share": "Поділитися файлом",

  "upload.failed": "Не вдалося завантажити",
  "upload.finalizeFailed": "Не вдалося завершити публікацію",

  "expiry.1h": "1 година",
  "expiry.6h": "6 годин",
  "expiry.1d": "1 день",
  "expiry.7d": "7 днів",
  "expiry.30d": "30 днів",
  "expiry.never": "Ніколи",

  "relexp.never": "Ніколи не спливає",
  "relexp.expired": "Сплив",
  "relexp.minutes": "Спливає за {{count}} хв",
  "relexp.hours": "Спливає за {{count}} год",
  "relexp.days": "Спливає за {{count}} дн.",
};
