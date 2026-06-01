import type { Translation } from "./en.ts";

export const fr: Translation = {
  "app.tagline": "Déposez un fichier, partagez un lien.",
  "app.subtitle": "Chiffré, et effacé à son expiration.",
  "theme.toggle": "Changer de thème",
  "language.label": "Langue",

  "drop.drag": "Glissez un fichier ici",
  "drop.browse": "ou cliquez pour parcourir",
  "drop.replace": "déposez-en un autre pour remplacer",

  "settings.title": "Options de partage",
  "settings.expiresAfter": "Expire après",
  "settings.password": "Mot de passe (facultatif)",
  "settings.passwordPlaceholder": "Laisser vide pour aucun",
  "settings.limitDownloads": "Limiter les téléchargements",
  "settings.maxDownloads": "Téléchargements max",
  "settings.upload": "Envoyer & partager",

  "result.ready": "Prêt à partager",
  "result.copy": "Copier le lien",
  "result.copied": "Copié",

  "result.copyFailed": "Copie impossible — sélectionnez le lien et copiez-le manuellement.",
  "result.shareAnother": "Partager un autre fichier",
  "result.downloadQr": "Enregistrer le QR code",
  "result.neverExpires": "N'expire jamais",
  "result.expiresAfter": "Expire après {{label}}",

  "download.protected": "Ce fichier est protégé par mot de passe",
  "download.passwordPlaceholder": "Saisir le mot de passe",
  "download.unlock": "Déverrouiller & télécharger",
  "download.download": "Télécharger",
  "download.wrongPassword": "Mot de passe incorrect",
  "download.failed": "Échec du téléchargement",

  "download.encryptedFile": "Fichier chiffré",
  "download.downloadsLeft": "Téléchargements restants : {{count}}",

  "download.missingKey": "Ce lien n'a pas sa clé de déchiffrement — il a peut-être été copié de façon incomplète.",

  "notfound.title": "Rien ici",
  "notfound.body": "Ce lien est invalide, ou le fichier a expiré et a été supprimé.",
  "notfound.share": "Partager un fichier",

  "upload.failed": "Échec de l'envoi",
  "upload.finalizeFailed": "Impossible de finaliser le partage",

  "expiry.1h": "1 heure",
  "expiry.6h": "6 heures",
  "expiry.1d": "1 jour",
  "expiry.7d": "7 jours",
  "expiry.30d": "30 jours",
  "expiry.never": "Jamais",

  "relexp.never": "N'expire jamais",
  "relexp.expired": "Expiré",
  "relexp.minutes": "Expire dans {{count}} min",
  "relexp.hours": "Expire dans {{count}} h",
  "relexp.days": "Expire dans {{count}} jours",
};
