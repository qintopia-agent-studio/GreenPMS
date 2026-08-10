import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError } from "./api";
import { AppShell, LoginPage, ServiceFailureState, WorkspaceProvider } from "./session";
import type { PrincipalDto } from "./types";
import { LoadingBlock } from "./ui";
import { InventoryPage } from "./pages/InventoryPage";
import { HistoricalOrderArchiveDetailPage, HistoricalOrderArchivesPage } from "./pages/HistoricalOrderArchivesPage";
import { MembersPage } from "./pages/MembersPage";
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { OrdersPage } from "./pages/OrdersPage";
import { TodayPage } from "./pages/TodayPage";
import { TokensPage } from "./pages/TokensPage";

export default function App() {
  const [principal, setPrincipal] = useState<PrincipalDto>();
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState<unknown>();
  const sessionRequestId = useRef(0);

  async function checkSession() {
    const requestId = ++sessionRequestId.current;
    setCheckingSession(true);
    setSessionError(undefined);
    try {
      const nextPrincipal = await api.me();
      if (requestId !== sessionRequestId.current) return;
      setPrincipal(nextPrincipal);
    } catch (error) {
      if (requestId !== sessionRequestId.current) return;
      if (error instanceof ApiError && error.status === 401) {
        setPrincipal(undefined);
      } else {
        setSessionError(error);
      }
    } finally {
      if (requestId === sessionRequestId.current) setCheckingSession(false);
    }
  }

  useEffect(() => {
    void checkSession();
    return () => { sessionRequestId.current += 1; };
  }, []);

  if (checkingSession) return <main className="startup-state"><LoadingBlock label="正在检查登录状态" /></main>;
  if (sessionError) {
    return <ServiceFailureState error={sessionError} title="无法确认登录状态" onRetry={() => void checkSession()} testId="session-startup-error" />;
  }
  if (!principal) return <LoginPage onLogin={setPrincipal} />;

  return (
    <BrowserRouter>
      <WorkspaceProvider principal={principal}>
        <Routes>
          <Route element={<AppShell onLogout={() => setPrincipal(undefined)} />}>
            <Route index element={<InventoryPage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="orders/:orderId" element={<OrderDetailPage />} />
            <Route path="historical-order-archives" element={<HistoricalOrderArchivesPage />} />
            <Route path="historical-order-archives/:archiveId" element={<HistoricalOrderArchiveDetailPage />} />
            <Route path="today" element={<TodayPage />} />
            <Route path="tokens" element={<TokensPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </WorkspaceProvider>
    </BrowserRouter>
  );
}
