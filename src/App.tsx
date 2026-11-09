import { Routes, Route } from "react-router-dom";
import HomePage from "@/app/page";
import NotFound from "@/app/not-found";
import { DownloadPage } from "./routes/DownloadPage";
import { ManagePage } from "./routes/ManagePage";
import { NotePage } from "./routes/NotePage";
import { RequestPage } from "./routes/RequestPage";
import { SendPage } from "./routes/SendPage";
import { CollectPage } from "./routes/CollectPage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/d/:slug" element={<DownloadPage />} />
      <Route path="/m/:slug" element={<ManagePage />} />
      <Route path="/note" element={<NotePage />} />
      <Route path="/request" element={<RequestPage />} />
      <Route path="/r/:slug" element={<SendPage />} />
      <Route path="/c/:slug" element={<CollectPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
