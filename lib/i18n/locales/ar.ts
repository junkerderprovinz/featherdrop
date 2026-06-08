import type { Translation } from "./en.ts";

export const ar: Translation = {
  "app.tagline": "شارك ملفاتك بأمان وخصوصية",
  "app.subtitle": "مشفّر، ويختفي عند انتهاء صلاحيته.",
  "app.privacy": "تشفير · حذف تلقائي · بدون تتبّع · بدون حساب · بدون هراء",
  "theme.toggle": "تبديل السمة",
  "language.label": "اللغة",

  "drop.drag": "اسحب ملفًا إلى هنا",
  "drop.browse": "أو انقر للتصفح",
  "drop.replace": "أفلِت ملفًا آخر للاستبدال",

  "settings.title": "خيارات التنزيل",
  "settings.expiresAfter": "تنتهي الصلاحية بعد",
  "settings.password": "كلمة المرور (اختيارية)",
  "settings.passwordPlaceholder": "اتركها فارغة لعدم وجود كلمة مرور",
  "settings.limitDownloads": "حدّ عدد التنزيلات",
  "settings.maxDownloads": "أقصى عدد للتنزيلات",
  "settings.upload": "ارفع وشارِك",

  "result.ready": "جاهز للمشاركة",
  "result.copy": "نسخ الرابط",
  "result.copied": "تم النسخ",

  "result.copyFailed": "تعذّر النسخ — حدّد الرابط وانسخه يدويًا.",
  "result.shareAnother": "مشاركة ملف آخر",
  "result.downloadQr": "حفظ رمز QR",
  "result.neverExpires": "لا تنتهي صلاحيته أبدًا",
  "result.expiresAfter": "تنتهي الصلاحية بعد {{label}}",

  "download.protected": "هذا الملف محمي بكلمة مرور",
  "download.passwordPlaceholder": "أدخل كلمة المرور",
  "download.unlock": "افتح القفل ونزّل",
  "download.download": "تنزيل",
  "download.wrongPassword": "كلمة مرور خاطئة",
  "download.failed": "فشل التنزيل",

  "download.encryptedFile": "ملف مشفّر",
  "download.downloadsLeft": "التنزيلات المتبقية: {{count}}",

  "download.missingKey": "هذا الرابط ينقصه مفتاح فك التشفير — ربما نُسخ بشكل غير كامل.",

  "notfound.title": "لا شيء هنا",
  "notfound.body": "هذا الرابط غير صالح، أو انتهت صلاحية الملف وتمت إزالته.",
  "notfound.share": "مشاركة ملف",

  "upload.failed": "فشل الرفع",
  "upload.finalizeFailed": "تعذّر إتمام المشاركة",

  "expiry.1h": "ساعة واحدة",
  "expiry.6h": "6 ساعات",
  "expiry.1d": "يوم واحد",
  "expiry.7d": "7 أيام",
  "expiry.30d": "30 يومًا",
  "expiry.never": "أبدًا",

  "relexp.never": "لا تنتهي صلاحيته أبدًا",
  "relexp.expired": "انتهت الصلاحية",
  "relexp.minutes": "تنتهي خلال {{count}} دقيقة",
  "relexp.hours": "تنتهي خلال {{count}} ساعة",
  "relexp.days": "تنتهي خلال {{count}} يوم",
};
