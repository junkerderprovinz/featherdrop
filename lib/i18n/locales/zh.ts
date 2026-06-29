import type { Translation } from "./en.ts";

export const zh: Translation = {
  "app.tagline": "安全且私密地分享你的文件",
  "app.subtitle": "端到端加密 — 服务器永远看不到你的文件。自动删除。",
  "app.privacy": "端到端加密 · 自动删除 · 无追踪 · 无需账户 · 绝无废话",
  "theme.toggle": "切换主题",
  "language.label": "语言",


  "insecure.warning": "连接不安全（HTTP）。大文件上传和流式下载受限。请通过 HTTPS 打开本页面以使用全部功能。",
  "drop.drag": "将文件拖到此处",
  "drop.browse": "或点击浏览",
  "drop.replace": "拖入另一个以替换",
  "drop.replaceMulti": "再次拖放以替换",
  "drop.fileCount": "文件数：{{count}}",
  "drop.total": "总计：{{size}}",

  "settings.title": "下载选项",
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
  "download.multiFile": "已加密的文件",
  "download.fileCount": "文件数：{{count}}",
  "download.total": "总计：{{size}}",
  "download.downloadAll": "全部下载",
  "download.saveToFolder": "保存到文件夹",

  "preview.show": "预览",
  "preview.hide": "隐藏预览",
  "preview.tooLarge": "太大无法预览 — 下载后查看",

  "notfound.title": "这里什么都没有",
  "notfound.body": "此链接无效，或文件已过期并被删除。",
  "notfound.share": "分享文件",

  "upload.failed": "上传失败",
  "upload.finalizeFailed": "无法完成分享",
  "upload.encrypting": "加密中…",

  "uploadGate.title": "此实例需要上传密码",
  "uploadGate.password": "上传密码",
  "uploadGate.placeholder": "请输入上传密码",
  "uploadGate.unlock": "解锁上传",
  "uploadGate.wrongPassword": "上传密码错误",

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
