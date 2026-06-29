"use client";

import { createContext, useContext } from "react";

// Runtime server configuration the client needs. Next.js does not expose plain
// (non-NEXT_PUBLIC) runtime env vars to client components, so the server resolves
// them once (lib/config) and passes them down as plain props; client components
// read them via useServerConfig.
interface ServerConfig {
  // Public BASE_URL used to build share links behind a reverse proxy.
  baseUrl: string;
  // Whether this instance gates uploads behind an operator-set upload password
  // (UPLOAD_PASSWORD). Only the BOOLEAN is exposed — the secret itself NEVER
  // leaves the server. When true, the UI prompts for the password before
  // uploading; when false, uploading is open (the default).
  uploadProtected: boolean;
}

const ServerConfigContext = createContext<ServerConfig>({
  baseUrl: "",
  uploadProtected: false,
});

export function ServerConfigProvider({
  config,
  children,
}: {
  config: ServerConfig;
  children: React.ReactNode;
}) {
  return (
    <ServerConfigContext.Provider value={config}>
      {children}
    </ServerConfigContext.Provider>
  );
}

export function useServerConfig() {
  return useContext(ServerConfigContext);
}
