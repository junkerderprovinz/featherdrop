import { Routes, Route } from "react-router-dom";
import HomePage from "@/app/page";
import NotFound from "@/app/not-found";
import { DownloadPage } from "./routes/DownloadPage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/d/:slug" element={<DownloadPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
