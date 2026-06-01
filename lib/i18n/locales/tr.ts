import type { Translation } from "./en.ts";

export const tr: Translation = {
  "app.tagline": "Bir dosya bırak, bir bağlantı paylaş.",
  "app.subtitle": "Şifreli, ve süresi dolunca yok olur.",
  "theme.toggle": "Temayı değiştir",
  "language.label": "Dil",

  "drop.drag": "Bir dosyayı buraya sürükle",
  "drop.browse": "ya da göz atmak için tıkla",
  "drop.replace": "değiştirmek için başka birini bırak",

  "settings.title": "Paylaşım seçenekleri",
  "settings.expiresAfter": "Şu süre sonra sona erer",
  "settings.password": "Parola (isteğe bağlı)",
  "settings.passwordPlaceholder": "Hiçbiri için boş bırakın",
  "settings.limitDownloads": "İndirmeleri sınırla",
  "settings.maxDownloads": "Maks. indirme",
  "settings.upload": "Yükle ve paylaş",

  "result.ready": "Paylaşıma hazır",
  "result.copy": "Bağlantıyı kopyala",
  "result.copied": "Kopyalandı",

  "result.copyFailed": "Kopyalanamadı — bağlantıyı seçip elle kopyalayın.",
  "result.shareAnother": "Başka bir dosya paylaş",
  "result.neverExpires": "Asla sona ermez",
  "result.expiresAfter": "{{label}} sonra sona erer",

  "download.protected": "Bu dosya parola korumalı",
  "download.passwordPlaceholder": "Parolayı girin",
  "download.unlock": "Kilidi aç ve indir",
  "download.download": "İndir",
  "download.wrongPassword": "Yanlış parola",
  "download.failed": "İndirme başarısız oldu",

  "download.encryptedFile": "Şifreli dosya",
  "download.downloadsLeft": "Kalan indirme: {{count}}",

  "download.missingKey": "Bu bağlantının şifre çözme anahtarı eksik — eksik kopyalanmış olabilir.",

  "notfound.title": "Burada bir şey yok",
  "notfound.body": "Bu bağlantı geçersiz veya dosya sona erip kaldırılmış.",
  "notfound.share": "Bir dosya paylaş",

  "upload.failed": "Yükleme başarısız oldu",
  "upload.finalizeFailed": "Paylaşım tamamlanamadı",

  "expiry.1h": "1 saat",
  "expiry.6h": "6 saat",
  "expiry.1d": "1 gün",
  "expiry.7d": "7 gün",
  "expiry.30d": "30 gün",
  "expiry.never": "Asla",

  "relexp.never": "Asla sona ermez",
  "relexp.expired": "Süresi doldu",
  "relexp.minutes": "{{count}} dk içinde sona erer",
  "relexp.hours": "{{count}} sa içinde sona erer",
  "relexp.days": "{{count}} gün içinde sona erer",
};
