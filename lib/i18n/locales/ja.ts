import type { Translation } from "./en.ts";

export const ja: Translation = {
  "app.tagline": "ファイルをドロップして、リンクを共有。",
  "app.subtitle": "暗号化され、期限が切れると消えます。",
  "app.privacy": "セルフホスト · 暗号化 · アカウント不要・追跡なし",
  "theme.toggle": "テーマを切り替え",
  "language.label": "言語",

  "drop.drag": "ここにファイルをドラッグ",
  "drop.browse": "またはクリックして選択",
  "drop.replace": "別のファイルをドロップして置き換え",

  "settings.title": "共有オプション",
  "settings.expiresAfter": "有効期限",
  "settings.password": "パスワード（任意）",
  "settings.passwordPlaceholder": "なしの場合は空欄",
  "settings.limitDownloads": "ダウンロード回数を制限",
  "settings.maxDownloads": "最大ダウンロード回数",
  "settings.upload": "アップロードして共有",

  "result.ready": "共有の準備完了",
  "result.copy": "リンクをコピー",
  "result.copied": "コピーしました",

  "result.copyFailed": "コピーできませんでした。リンクを選択して手動でコピーしてください。",
  "result.shareAnother": "別のファイルを共有",
  "result.downloadQr": "QRコードを保存",
  "result.neverExpires": "無期限",
  "result.expiresAfter": "{{label}}後に期限切れ",

  "download.protected": "このファイルはパスワードで保護されています",
  "download.passwordPlaceholder": "パスワードを入力",
  "download.unlock": "ロック解除してダウンロード",
  "download.download": "ダウンロード",
  "download.wrongPassword": "パスワードが違います",
  "download.failed": "ダウンロードに失敗しました",

  "download.encryptedFile": "暗号化されたファイル",
  "download.downloadsLeft": "残りダウンロード回数: {{count}}",

  "download.missingKey": "このリンクには復号鍵がありません。途中までしかコピーされていない可能性があります。",

  "notfound.title": "ここには何もありません",
  "notfound.body": "このリンクは無効か、ファイルが期限切れで削除されています。",
  "notfound.share": "ファイルを共有",

  "upload.failed": "アップロードに失敗しました",
  "upload.finalizeFailed": "共有を完了できませんでした",

  "expiry.1h": "1時間",
  "expiry.6h": "6時間",
  "expiry.1d": "1日",
  "expiry.7d": "7日",
  "expiry.30d": "30日",
  "expiry.never": "なし",

  "relexp.never": "無期限",
  "relexp.expired": "期限切れ",
  "relexp.minutes": "あと{{count}}分で期限切れ",
  "relexp.hours": "あと{{count}}時間で期限切れ",
  "relexp.days": "あと{{count}}日で期限切れ",
};
