import type { Translation } from "./en.ts";

export const zh: Translation = {
  "app.tagline": "拖入文件，分享链接。",
  "app.subtitle": "已加密，过期后即消失。",
  "theme.toggle": "切换主题",
  "language.label": "语言",

  "drop.drag": "将文件拖到此处",
  "drop.browse": "或点击浏览",
  "drop.replace": "拖入另一个以替换",

  "settings.title": "分享选项",
  "settings.expiresAfter": "过期时间",
  "settings.password": "密码（可选）",
  "settings.passwordPlaceholder": "留空表示无密码",
  "settings.limitDownloads": "限制下载次数",
  "settings.maxDownloads": "最大下载次数",
  "settings.upload": "上传并分享",

  "result.ready": "已准备好分享",
  "result.copy": "复制链接",
  "result.copied": "已复制",

  "result.copyFailed": "无法复制 — 请选中链接手动复制。",
  "result.shareAnother": "分享另一个文件",
  "result.downloadQr": "保存二维码",
  "result.neverExpires": "永不过期",
  "result.expiresAfter": "{{label}}后过期",

  "download.protected": "此文件受密码保护",
  "download.passwordPlaceholder": "输入密码",
  "download.unlock": "解锁并下载",
  "download.download": "下载",
  "download.wrongPassword": "密码错误",
  "download.failed": "下载失败",

  "download.encryptedFile": "已加密的文件",
  "download.downloadsLeft": "剩余下载次数：{{count}}",

  "download.missingKey": "此链接缺少解密密钥 — 可能复制不完整。",

  "notfound.title": "这里什么都没有",
  "notfound.body": "此链接无效，或文件已过期并被删除。",
  "notfound.share": "分享文件",

  "upload.failed": "上传失败",
  "upload.finalizeFailed": "无法完成分享",

  "expiry.1h": "1 小时",
  "expiry.6h": "6 小时",
  "expiry.1d": "1 天",
  "expiry.7d": "7 天",
  "expiry.30d": "30 天",
  "expiry.never": "永不",

  "relexp.never": "永不过期",
  "relexp.expired": "已过期",
  "relexp.minutes": "{{count}} 分钟后过期",
  "relexp.hours": "{{count}} 小时后过期",
  "relexp.days": "{{count}} 天后过期",
};
