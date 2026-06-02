import type { Translation } from "./en.ts";

export const es: Translation = {
  "app.tagline": "Suelta un archivo, comparte un enlace.",
  "app.subtitle": "Cifrado, y desaparece al caducar.",
  "app.privacy": "Autoalojado · cifrado · sin cuentas, sin rastreo",
  "theme.toggle": "Cambiar tema",
  "language.label": "Idioma",

  "drop.drag": "Arrastra un archivo aquí",
  "drop.browse": "o haz clic para explorar",
  "drop.replace": "suelta otro para reemplazar",

  "settings.title": "Opciones para compartir",
  "settings.expiresAfter": "Caduca tras",
  "settings.password": "Contraseña (opcional)",
  "settings.passwordPlaceholder": "Déjalo vacío para ninguna",
  "settings.limitDownloads": "Limitar descargas",
  "settings.maxDownloads": "Descargas máximas",
  "settings.upload": "Subir y compartir",

  "result.ready": "Listo para compartir",
  "result.copy": "Copiar enlace",
  "result.copied": "Copiado",

  "result.copyFailed": "No se pudo copiar: selecciona el enlace y cópialo manualmente.",
  "result.shareAnother": "Compartir otro archivo",
  "result.downloadQr": "Guardar código QR",
  "result.neverExpires": "Nunca caduca",
  "result.expiresAfter": "Caduca tras {{label}}",

  "download.protected": "Este archivo está protegido con contraseña",
  "download.passwordPlaceholder": "Introduce la contraseña",
  "download.unlock": "Desbloquear y descargar",
  "download.download": "Descargar",
  "download.wrongPassword": "Contraseña incorrecta",
  "download.failed": "Error en la descarga",

  "download.encryptedFile": "Archivo cifrado",
  "download.downloadsLeft": "Descargas restantes: {{count}}",

  "download.missingKey": "A este enlace le falta su clave de descifrado; puede que se haya copiado de forma incompleta.",

  "notfound.title": "Aquí no hay nada",
  "notfound.body": "Este enlace no es válido, o el archivo ha caducado y se ha eliminado.",
  "notfound.share": "Compartir un archivo",

  "upload.failed": "Error al subir",
  "upload.finalizeFailed": "No se pudo finalizar el recurso compartido",

  "expiry.1h": "1 hora",
  "expiry.6h": "6 horas",
  "expiry.1d": "1 día",
  "expiry.7d": "7 días",
  "expiry.30d": "30 días",
  "expiry.never": "Nunca",

  "relexp.never": "Nunca caduca",
  "relexp.expired": "Caducado",
  "relexp.minutes": "Caduca en {{count}} min",
  "relexp.hours": "Caduca en {{count}} h",
  "relexp.days": "Caduca en {{count}} días",
};
