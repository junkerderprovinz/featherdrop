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
