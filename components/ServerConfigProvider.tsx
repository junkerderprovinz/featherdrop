"use client";

import { createContext, useContext } from "react";

// The runtime configuration from /api/config.
interface ServerConfig {
  // BASE_URL for share links behind a reverse proxy.
  baseUrl: string;
  // Set when UPLOAD_PASSWORD gates uploads; the password itself never leaves
  // the server.
  uploadProtected: boolean;
  // Preselected without a stored preference; empty means "7d".
  defaultExpiry: string;
  // Longer options are hidden, and the server rejects them. Empty or "never"
  // means no cap.
  maxExpiry: string;
}

const ServerConfigContext = createContext<ServerConfig>({
  baseUrl: "",
  uploadProtected: false,
  defaultExpiry: "",
  maxExpiry: "",
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
