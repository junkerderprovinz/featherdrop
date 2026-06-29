// Drop-in replacement for `next/link`, aliased to this module in vite.config.ts.
//
// The featherdrop components import `Link from "next/link"` in exactly two ways:
//   - <Link href="/" style={…}>…</Link>            (DownloadView, ManageView)
//   - <Button component={Link} href="/" …/>         (ManageView — Mantine
//     polymorphic `component`, which forwards arbitrary props AND a ref)
//
// So this shim must (a) accept `href` like next/link, (b) forward every other
// prop (className/style/onClick/role/…) onto the rendered element, and (c)
// forward a ref so Mantine's `component={Link}` works. Internal app paths route
// client-side via react-router's <Link>; external/absolute/protocol/anchor/mail
// targets fall back to a plain <a> so they leave the SPA normally.
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";

export interface LinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  // next/link accepts string | UrlObject; the components only ever pass a string.
  href: string;
  children?: ReactNode;
}

// A path that should leave the SPA (or is not a client route) and so must render
// as a real <a>: absolute URLs, protocol-relative, mailto/tel, and #fragments.
function isExternalHref(href: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) || // scheme: http:, mailto:, tel:, …
    href.startsWith("//") || // protocol-relative
    href.startsWith("#") // in-page anchor
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
