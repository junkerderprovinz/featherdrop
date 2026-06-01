import type { Translation } from "./en.ts";

export const ko: Translation = {
  "app.tagline": "파일을 놓고, 링크를 공유하세요.",
  "app.subtitle": "암호화되며, 만료되면 사라집니다.",
  "theme.toggle": "테마 전환",
  "language.label": "언어",

  "drop.drag": "여기에 파일을 끌어다 놓으세요",
  "drop.browse": "또는 클릭하여 찾아보기",
  "drop.replace": "교체하려면 다른 파일을 놓으세요",

  "settings.title": "공유 옵션",
  "settings.expiresAfter": "만료 시점",
  "settings.password": "비밀번호 (선택)",
  "settings.passwordPlaceholder": "없으면 비워 두세요",
  "settings.limitDownloads": "다운로드 횟수 제한",
  "settings.maxDownloads": "최대 다운로드 횟수",
  "settings.upload": "업로드 및 공유",

  "result.ready": "공유 준비 완료",
  "result.copy": "링크 복사",
  "result.copied": "복사됨",

  "result.copyFailed": "복사하지 못했습니다 — 링크를 선택해 직접 복사하세요.",
  "result.shareAnother": "다른 파일 공유",
  "result.downloadQr": "QR 코드 저장",
  "result.neverExpires": "만료되지 않음",
  "result.expiresAfter": "{{label}} 후 만료",

  "download.protected": "이 파일은 비밀번호로 보호되어 있습니다",
  "download.passwordPlaceholder": "비밀번호 입력",
  "download.unlock": "잠금 해제 후 다운로드",
  "download.download": "다운로드",
  "download.wrongPassword": "잘못된 비밀번호",
  "download.failed": "다운로드 실패",

  "download.encryptedFile": "암호화된 파일",
  "download.downloadsLeft": "남은 다운로드 횟수: {{count}}",

  "download.missingKey": "이 링크에 복호화 키가 없습니다. 불완전하게 복사되었을 수 있습니다.",

  "notfound.title": "여기에 아무것도 없습니다",
  "notfound.body": "이 링크가 유효하지 않거나 파일이 만료되어 삭제되었습니다.",
  "notfound.share": "파일 공유",

  "upload.failed": "업로드 실패",
  "upload.finalizeFailed": "공유를 완료할 수 없습니다",

  "expiry.1h": "1시간",
  "expiry.6h": "6시간",
  "expiry.1d": "1일",
  "expiry.7d": "7일",
  "expiry.30d": "30일",
  "expiry.never": "안 함",

  "relexp.never": "만료되지 않음",
  "relexp.expired": "만료됨",
  "relexp.minutes": "{{count}}분 후 만료",
  "relexp.hours": "{{count}}시간 후 만료",
  "relexp.days": "{{count}}일 후 만료",
};
