import type { Translation } from "./en.ts";

export const pt: Translation = {
  "app.tagline": "Partilha os teus ficheiros de forma segura e privada",
  "app.subtitle": "Encriptado, e desaparece ao expirar.",
  "app.privacy": "Encriptação · eliminação automática · sem rastreio · sem conta · sem tretas",
  "theme.toggle": "Alternar tema",
  "language.label": "Idioma",

  "drop.drag": "Arraste um ficheiro para aqui",
  "drop.browse": "ou clique para procurar",
  "drop.replace": "solte outro para substituir",

  "settings.title": "Opções de transferência",
  "settings.expiresAfter": "Expira após",
  "settings.password": "Palavra-passe (opcional)",
  "settings.passwordPlaceholder": "Deixe vazio para nenhuma",
  "settings.limitDownloads": "Limitar transferências",
  "settings.maxDownloads": "Transferências máx.",
  "settings.upload": "Carregar e partilhar",

  "result.ready": "Pronto para partilhar",
  "result.copy": "Copiar link",
  "result.copied": "Copiado",

  "result.copyFailed": "Não foi possível copiar — selecione o link e copie manualmente.",
  "result.shareAnother": "Partilhar outro ficheiro",
  "result.downloadQr": "Guardar código QR",
  "result.neverExpires": "Nunca expira",
  "result.expiresAfter": "Expira após {{label}}",

  "download.protected": "Este ficheiro está protegido por palavra-passe",
  "download.passwordPlaceholder": "Introduza a palavra-passe",
  "download.unlock": "Desbloquear e transferir",
  "download.download": "Transferir",
  "download.wrongPassword": "Palavra-passe errada",
  "download.failed": "Falha na transferência",

  "download.encryptedFile": "Ficheiro encriptado",
  "download.downloadsLeft": "Transferências restantes: {{count}}",

  "download.missingKey": "Falta a chave de desencriptação a este link — pode ter sido copiado de forma incompleta.",

  "notfound.title": "Não há nada aqui",
  "notfound.body": "Este link é inválido, ou o ficheiro expirou e foi removido.",
  "notfound.share": "Partilhar um ficheiro",

  "upload.failed": "Falha no carregamento",
  "upload.finalizeFailed": "Não foi possível finalizar a partilha",
  "upload.encrypting": "A cifrar…",

  "expiry.1h": "1 hora",
  "expiry.6h": "6 horas",
  "expiry.1d": "1 dia",
  "expiry.7d": "7 dias",
  "expiry.30d": "30 dias",
  "expiry.never": "Nunca",

  "relexp.never": "Nunca expira",
  "relexp.expired": "Expirado",
  "relexp.minutes": "Expira em {{count}} min",
  "relexp.hours": "Expira em {{count}} h",
  "relexp.days": "Expira em {{count}} dias",
};
