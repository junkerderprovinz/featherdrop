import type { Translation } from "./en.ts";

export const th: Translation = {
  "app.tagline": "แชร์ไฟล์ของคุณอย่างปลอดภัยและเป็นส่วนตัว",
  "app.subtitle": "เข้ารหัสแบบ end-to-end — เซิร์ฟเวอร์ไม่เคยเห็นไฟล์ของคุณ ลบอัตโนมัติ",
  "app.privacy": "เข้ารหัสแบบ end-to-end · ลบอัตโนมัติ · ไม่มีการติดตาม · ไม่ต้องมีบัญชี · ไม่มีเรื่องไร้สาระ",
  "theme.toggle": "สลับธีม",
  "language.label": "ภาษา",


  "insecure.warning": "การเชื่อมต่อไม่ปลอดภัย (HTTP) การอัปโหลดขนาดใหญ่และการดาวน์โหลดแบบสตรีมถูกจำกัด เปิดหน้านี้ผ่าน HTTPS เพื่อใช้งานได้เต็มรูปแบบ",
  "drop.drag": "ลากไฟล์มาที่นี่",
  "drop.browse": "หรือคลิกเพื่อเลือก",
  "drop.replace": "วางไฟล์อื่นเพื่อแทนที่",
  "drop.replaceMulti": "วางอีกครั้งเพื่อแทนที่",
  "drop.fileCount": "ไฟล์: {{count}}",
  "drop.total": "รวม: {{size}}",

  "settings.title": "ตัวเลือกการดาวน์โหลด",
  "settings.expiresAfter": "หมดอายุหลังจาก",
  "settings.password": "รหัสผ่าน (ไม่บังคับ)",
  "settings.passwordPlaceholder": "เว้นว่างไว้หากไม่ต้องการ",
  "settings.limitDownloads": "จำกัดจำนวนดาวน์โหลด",
  "settings.maxDownloads": "ดาวน์โหลดสูงสุด",
  "settings.upload": "อัปโหลดและแชร์",

  "result.ready": "พร้อมแชร์",
  "result.copy": "คัดลอกลิงก์",
  "result.copied": "คัดลอกแล้ว",

  "result.copyFailed": "คัดลอกไม่สำเร็จ — เลือกลิงก์แล้วคัดลอกเอง",
  "result.shareAnother": "แชร์ไฟล์อื่น",
  "result.downloadQr": "บันทึกคิวอาร์โค้ด",
  "result.neverExpires": "ไม่หมดอายุ",
  "result.expiresAfter": "หมดอายุหลังจาก {{label}}",

  "download.protected": "ไฟล์นี้มีการป้องกันด้วยรหัสผ่าน",
  "download.passwordPlaceholder": "ใส่รหัสผ่าน",
  "download.unlock": "ปลดล็อกและดาวน์โหลด",
  "download.download": "ดาวน์โหลด",
  "download.wrongPassword": "รหัสผ่านไม่ถูกต้อง",
  "download.failed": "ดาวน์โหลดล้มเหลว",

  "download.encryptedFile": "ไฟล์ที่เข้ารหัส",
  "download.downloadsLeft": "ดาวน์โหลดที่เหลือ: {{count}}",

  "download.missingKey": "ลิงก์นี้ไม่มีคีย์ถอดรหัส — อาจถูกคัดลอกมาไม่ครบ",
  "download.multiFile": "ไฟล์ที่เข้ารหัส",
  "download.fileCount": "ไฟล์: {{count}}",
  "download.total": "รวม: {{size}}",
  "download.downloadAll": "ดาวน์โหลดทั้งหมด",
  "download.saveToFolder": "บันทึกลงโฟลเดอร์",

  "preview.show": "แสดงตัวอย่าง",
  "preview.hide": "ซ่อนตัวอย่าง",
  "preview.tooLarge": "ใหญ่เกินกว่าจะแสดงตัวอย่าง — ดาวน์โหลดเพื่อดู",

  "notfound.title": "ไม่มีอะไรที่นี่",
  "notfound.body": "ลิงก์นี้ไม่ถูกต้อง หรือไฟล์หมดอายุและถูกลบไปแล้ว",
  "notfound.share": "แชร์ไฟล์",

  "upload.failed": "อัปโหลดล้มเหลว",
  "upload.finalizeFailed": "ไม่สามารถดำเนินการแชร์ให้เสร็จสิ้นได้",
  "upload.encrypting": "กำลังเข้ารหัส…",

  "uploadGate.title": "อินสแตนซ์นี้ต้องใช้รหัสผ่านสำหรับการอัปโหลด",
  "uploadGate.password": "รหัสผ่านสำหรับการอัปโหลด",
  "uploadGate.placeholder": "ป้อนรหัสผ่านสำหรับการอัปโหลด",
  "uploadGate.unlock": "ปลดล็อกการอัปโหลด",
  "uploadGate.wrongPassword": "รหัสผ่านสำหรับการอัปโหลดไม่ถูกต้อง",

  "expiry.1h": "1 ชั่วโมง",
  "expiry.6h": "6 ชั่วโมง",
  "expiry.1d": "1 วัน",
  "expiry.7d": "7 วัน",
  "expiry.30d": "30 วัน",
  "expiry.never": "ไม่เลย",

  "relexp.never": "ไม่หมดอายุ",
  "relexp.expired": "หมดอายุแล้ว",
  "relexp.minutes": "หมดอายุในอีก {{count}} นาที",
  "relexp.hours": "หมดอายุในอีก {{count}} ชม.",
  "relexp.days": "หมดอายุในอีก {{count}} วัน",
};
