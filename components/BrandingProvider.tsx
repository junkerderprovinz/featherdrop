"use client";

import { createContext, useContext } from "react";

// The operator's wordmark and logo, loaded from /api/config.
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
