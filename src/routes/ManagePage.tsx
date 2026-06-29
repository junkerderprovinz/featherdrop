// Client replacement for app/m/[slug]/page.tsx — a thin shell that renders
// <ManageView slug={slug} />. ManageView reads the secret delete token from the
// URL #fragment in the browser and never looks the share up here, so this page
// needs no fetch (mirroring the Next page, which deliberately did no DB read).
import { useParams } from "react-router-dom";
import { ManageView } from "@/components/ManageView";

export function ManagePage() {
  const { slug = "" } = useParams();
  return <ManageView slug={slug} />;
}
