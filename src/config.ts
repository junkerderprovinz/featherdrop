// What only the server knows: the base URL, whether uploads need a password,
// the expiry it allows and its branding (APP_NAME, APP_LOGO, ACCENT_COLOR).
// The body of server-go/internal/api/config.go.
import { reactive } from "vue";

export interface ServerConfig {
  baseUrl: string;
  uploadProtected: boolean;
  /** "" for no preference or no cap. */
  defaultExpiry: string;
  maxExpiry: string;
  branding: { appName: string; logoUrl: string | null; accentColor: string | null };
}

export const config = reactive<ServerConfig>({
  baseUrl: "",
  uploadProtected: false,
  defaultExpiry: "",
  maxExpiry: "",
  branding: { appName: "CastleParcel", logoUrl: null, accentColor: null },
});

/** Loads /api/config. A server that does not answer leaves the defaults. */
export async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const data = (await res.json()) as Partial<ServerConfig>;
    config.baseUrl = data.baseUrl ?? "";
    config.uploadProtected = data.uploadProtected ?? false;
    config.defaultExpiry = data.defaultExpiry ?? "";
    config.maxExpiry = data.maxExpiry ?? "";
    Object.assign(config.branding, data.branding ?? {});
  } catch {
    // Offline or blocked: the page still opens shares it has the key for.
  }
}

export const baseUrl = () => config.baseUrl || location.origin;

/** Over plain HTTP there is no service worker and no crypto.subtle, so downloads do not stream and uploads cannot resume. */
export const insecure = !window.isSecureContext;
