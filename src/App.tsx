// SPA route table — mirrors the Next.js app/ file routes:
//   /            -> HomePage (app/page.tsx, the upload UI)
//   /d/:slug     -> DownloadPage (fetches /api/d/{slug}/meta, renders DownloadView)
//   /m/:slug     -> ManagePage (renders ManageView; reads the #fragment token)
//   *            -> the shared not-found view (app/not-found.tsx)
import { Routes, Route } from "react-router-dom";
import HomePage from "@/app/page";
import NotFound from "@/app/not-found";
import { DownloadPage } from "./routes/DownloadPage";
import { ManagePage } from "./routes/ManagePage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/d/:slug" element={<DownloadPage />} />
      <Route path="/m/:slug" element={<ManagePage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
