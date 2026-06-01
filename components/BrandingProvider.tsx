"use client";

import { createContext, useContext } from "react";

// Client-side branding context. The server resolves the operator's branding
// (lib/config BRANDING) and passes the display-facing parts down as plain props;
// client components read them via useBranding to render the wordmark and logo.
interface BrandingContextValue {
  appName: string;
  logoUrl: string | null;
}

const BrandingContext = createContext<BrandingContextValue>({
  appName: "featherdrop",
  logoUrl: null,
});

export function BrandingProvider({
  branding,
  children,
}: {
  branding: BrandingContextValue;
  children: React.ReactNode;
}) {
  return (
    <BrandingContext.Provider value={branding}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}
