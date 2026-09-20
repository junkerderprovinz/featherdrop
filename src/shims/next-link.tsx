// Stands in for `next/link`, aliased in vite.config.ts. The components use it
// both as <Link href> and as Mantine's `component={Link}`, which passes any
// props and a ref, so every prop and the ref are forwarded. App paths route
// through react-router; absolute, protocol, mail and anchor targets render a
// plain <a> and leave the SPA.
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";

export interface LinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  // next/link also takes a UrlObject; the components only pass strings.
  href: string;
  children?: ReactNode;
}

function isExternalHref(href: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) || // http:, mailto:, tel:, ...
    href.startsWith("//") ||
    href.startsWith("#")
  );
}

const NextLinkShim = forwardRef<HTMLAnchorElement, LinkProps>(
  function NextLinkShim({ href, children, ...rest }, ref) {
    if (isExternalHref(href)) {
      return (
        <a ref={ref} href={href} {...rest}>
          {children}
        </a>
      );
    }
    return (
      <RouterLink ref={ref} to={href} {...rest}>
        {children}
      </RouterLink>
    );
  },
);

export default NextLinkShim;
