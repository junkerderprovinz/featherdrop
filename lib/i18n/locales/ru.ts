import type { Translation } from "./en.ts";

export const ru: Translation = {
  "app.tagline": "Перетащите файл, поделитесь ссылкой.",
  "app.subtitle": "Зашифровано и исчезает по истечении срока.",
  "app.privacy": "Свой хостинг · шифрование · без аккаунтов и слежки",
  "theme.toggle": "Переключить тему",
  "language.label": "Язык",

  "drop.drag": "Перетащите файл сюда",
  "drop.browse": "или нажмите для выбора",
  "drop.replace": "перетащите другой для замены",

  "settings.title": "Параметры доступа",
  "settings.expiresAfter": "Истекает через",
  "settings.password": "Пароль (необязательно)",
  "settings.passwordPlaceholder": "Оставьте пустым, чтобы без пароля",
  "settings.limitDownloads": "Ограничить число скачиваний",
  "settings.maxDownloads": "Макс. скачиваний",
  "settings.upload": "Загрузить и поделиться",

  "result.ready": "Готово к отправке",
  "result.copy": "Копировать ссылку",
  "result.copied": "Скопировано",

  "result.copyFailed": "Не удалось скопировать — выделите ссылку и скопируйте вручную.",
  "result.shareAnother": "Поделиться другим файлом",
  "result.downloadQr": "Сохранить QR-код",
  "result.neverExpires": "Никогда не истекает",
  "result.expiresAfter": "Истекает через {{label}}",

  "download.protected": "Этот файл защищён паролем",
  "download.passwordPlaceholder": "Введите пароль",
  "download.unlock": "Разблокировать и скачать",
  "download.download": "Скачать",
  "download.wrongPassword": "Неверный пароль",
  "download.failed": "Не удалось скачать",

  "download.encryptedFile": "Зашифрованный файл",
  "download.downloadsLeft": "Осталось скачиваний: {{count}}",

  "download.missingKey": "В этой ссылке нет ключа расшифровки — возможно, она скопирована не полностью.",

  "notfound.title": "Здесь ничего нет",
  "notfound.body": "Эта ссылка недействительна, или файл истёк и был удалён.",
  "notfound.share": "Поделиться файлом",

  "upload.failed": "Не удалось загрузить",
  "upload.finalizeFailed": "Не удалось завершить публикацию",

  "expiry.1h": "1 час",
  "expiry.6h": "6 часов",
  "expiry.1d": "1 день",
  "expiry.7d": "7 дней",
  "expiry.30d": "30 дней",
  "expiry.never": "Никогда",

  "relexp.never": "Никогда не истекает",
  "relexp.expired": "Истёк",
  "relexp.minutes": "Истекает через {{count}} мин",
  "relexp.hours": "Истекает через {{count}} ч",
  "relexp.days": "Истекает через {{count}} дн.",
};
