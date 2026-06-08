"use client";

import { createContext, useContext } from "react";

// Runtime server configuration the client needs. Next.js does not expose plain
// (non-NEXT_PUBLIC) runtime env vars to client components, so the server resolves
// them once (lib/config) and passes them down as plain props; client components
// read them via useServerConfig. Currently just the public BASE_URL used to build
// share links behind a reverse proxy.
interface ServerConfig {
  baseUrl: string;
}

const ServerConfigContext = createContext<ServerConfig>({ baseUrl: "" });

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
