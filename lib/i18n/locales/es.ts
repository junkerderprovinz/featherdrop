import type { Translation } from "./en.ts";

export const es: Translation = {
  "app.tagline": "Comparte tus archivos de forma segura y privada",
  "app.subtitle": "Cifrado de extremo a extremo: el servidor nunca ve tus archivos. Se elimina automáticamente.",
  "app.privacy": "Cifrado de extremo a extremo · borrado automático · sin rastreo · sin cuenta · sin chorradas",
  "theme.toggle": "Cambiar tema",
  "language.label": "Idioma",


  "insecure.warning": "Conexión no segura (HTTP). Las subidas grandes y las descargas en streaming están limitadas. Abre esta página por HTTPS para todas las funciones.",
  "drop.drag": "Arrastra un archivo aquí",
  "drop.browse": "o haz clic para explorar",
  "drop.replace": "suelta otro para reemplazar",
  "drop.replaceMulti": "suelta de nuevo para reemplazar",
  "drop.fileCount": "Archivos: {{count}}",
  "drop.total": "Total: {{size}}",

  "settings.title": "Opciones de descarga",
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
  "download.multiFile": "Archivos cifrados",
  "download.fileCount": "Archivos: {{count}}",
  "download.total": "Total: {{size}}",
  "download.downloadAll": "Descargar todo",
  "download.saveToFolder": "Guardar en una carpeta",

  "preview.show": "Vista previa",
  "preview.hide": "Ocultar vista previa",
  "preview.tooLarge": "Demasiado grande para previsualizar — descárgalo para verlo",

  "notfound.title": "Aquí no hay nada",
  "notfound.body": "Este enlace no es válido, o el archivo ha caducado y se ha eliminado.",
  "notfound.share": "Compartir un archivo",

  "upload.failed": "Error al subir",
  "upload.finalizeFailed": "No se pudo finalizar el recurso compartido",
  "upload.encrypting": "Cifrando…",

  "uploadGate.title": "Esta instancia requiere una contraseña de subida",
  "uploadGate.password": "Contraseña de subida",
  "uploadGate.placeholder": "Introduce la contraseña de subida",
  "uploadGate.unlock": "Desbloquear la subida",
  "uploadGate.wrongPassword": "Contraseña de subida incorrecta",

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
