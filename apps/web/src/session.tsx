import { createContext, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { AlertCircle, BadgeCheck, BedDouble, Building2, ClipboardList, KeyRound, LogOut, PanelLeftClose, PanelLeftOpen, RefreshCw, Smartphone, UserRound } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { api, ApiError } from "./api";
import type { MetaDto, PendingTokenCommand, PrincipalDto, RetainedTokenSecret } from "./types";
import { errorMessage, LoadingBlock } from "./ui";

export function ServiceFailureState({ error, title, onRetry, testId }: {
  error: unknown;
  title: string;
  onRetry: () => void;
  testId: string;
}) {
  const errorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    errorRef.current?.focus();
  }, [error]);

  return (
    <main className="startup-state">
      <section className="service-failure" role="alert" tabIndex={-1} ref={errorRef} data-testid={testId}>
        <AlertCircle aria-hidden="true" size={20} />
        <div><h1>{title}</h1><p>{errorMessage(error)}</p></div>
      </section>
      <button className="button button-secondary" type="button" onClick={onRetry} data-testid={`${testId}-retry`}>
        <RefreshCw aria-hidden="true" size={17} />重试
      </button>
    </main>
  );
}

interface WorkspaceContextValue {
  principal: PrincipalDto;
  meta: MetaDto;
  propertyId: string;
  setPropertyId: (propertyId: string) => void;
  refreshMeta: () => Promise<void>;
  retainedTokenSecret: RetainedTokenSecret | undefined;
  setRetainedTokenSecret: Dispatch<SetStateAction<RetainedTokenSecret | undefined>>;
  pendingTokenCommand: PendingTokenCommand | undefined;
  setPendingTokenCommand: Dispatch<SetStateAction<PendingTokenCommand | undefined>>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace context is unavailable");
  return value;
}

export function LoginPage({ onLogin }: { onLogin: (principal: PrincipalDto) => void }) {
  const demoLoginEnabled = import.meta.env.DEV || import.meta.env.VITE_DEMO_LOGIN === "true";
  const [username, setUsername] = useState(demoLoginEnabled ? "operator" : "");
  const [password, setPassword] = useState(demoLoginEnabled ? "demo-pass-2026" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const errorRef = useRef<HTMLDivElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onLogin(await api.login(username, password));
    } catch (nextError) {
      setError(nextError);
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-word">QinTopia</span>
          <span>PMS Core Operations</span>
        </div>
        <div>
          <p className="eyebrow">运营工作台</p>
          <h1 id="login-title">登录</h1>
        </div>
        {error ? (
          <div className="inline-error" role="alert" tabIndex={-1} ref={errorRef}>
            <div><strong>登录失败</strong><p>{errorMessage(error)}</p></div>
          </div>
        ) : null}
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="username">账号</label>
          <input id="username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required autoFocus data-testid="login-username" />
          <label htmlFor="password">密码</label>
          <input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required data-testid="login-password" />
          <button className="button button-primary login-submit" type="submit" disabled={busy} data-testid="login-submit">{busy ? "正在登录..." : "进入工作台"}</button>
        </form>
        {demoLoginEnabled ? (
          <div className="demo-account" aria-label="演示账号">
            <span>演示账号</span>
            <code>operator</code>
            <code>demo-pass-2026</code>
          </div>
        ) : null}
      </section>
    </main>
  );
}

export function WorkspaceProvider({ principal, children }: {
  principal: PrincipalDto;
  children: ReactNode;
}) {
  const [meta, setMeta] = useState<MetaDto>();
  const [propertyId, setPropertyIdState] = useState("");
  const [error, setError] = useState<unknown>();
  const [retainedTokenSecret, setRetainedTokenSecret] = useState<RetainedTokenSecret>();
  const [pendingTokenCommand, setPendingTokenCommand] = useState<PendingTokenCommand>();
  const metaRequestId = useRef(0);

  async function refreshMeta() {
    const requestId = ++metaRequestId.current;
    let nextMeta: MetaDto;
    try {
      nextMeta = await api.meta();
    } catch (nextError) {
      if (requestId !== metaRequestId.current) return;
      throw nextError;
    }
    if (requestId !== metaRequestId.current) return;
    setError(undefined);
    setMeta(nextMeta);
    setPropertyIdState((current) => {
      if (current && nextMeta.properties.some((property) => property.id === current)) return current;
      const saved = storedLocalValue("qintopia.propertyId");
      if (saved && nextMeta.properties.some((property) => property.id === saved)) return saved;
      return nextMeta.properties[0]?.id ?? "";
    });
  }

  useEffect(() => {
    void refreshMeta().catch(setError);
    return () => { metaRequestId.current += 1; };
  }, []);

  function retryMeta() {
    setError(undefined);
    void refreshMeta().catch(setError);
  }

  function setPropertyId(nextPropertyId: string) {
    persistLocalValue("qintopia.propertyId", nextPropertyId);
    setPropertyIdState(nextPropertyId);
  }

  const value = useMemo<WorkspaceContextValue | undefined>(() => meta && propertyId ? ({
    principal,
    meta,
    propertyId,
    setPropertyId,
    refreshMeta,
    retainedTokenSecret,
    setRetainedTokenSecret,
    pendingTokenCommand,
    setPendingTokenCommand
  }) : undefined, [meta, pendingTokenCommand, principal, propertyId, retainedTokenSecret]);

  if (error) {
    return <ServiceFailureState error={error} title="无法载入工作区" onRetry={retryMeta} testId="workspace-startup-error" />;
  }
  if (!value) return <main className="startup-state"><LoadingBlock label="正在载入运营数据" /></main>;

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

const navigation = [
  { to: "/", label: "房态", icon: BedDouble, end: true },
  { to: "/orders", label: "订单", icon: ClipboardList, end: false },
  { to: "/members", label: "会员", icon: BadgeCheck, end: false },
  { to: "/tokens", label: "Token", icon: KeyRound, end: false, requiresWrite: true },
  { to: "/today", label: "今日履约", icon: Smartphone, end: false }
] as const;

export function navigationItemsForAccess(access: "READ" | "WRITE") {
  return navigation.filter((item) => !("requiresWrite" in item && item.requiresWrite && access !== "WRITE"));
}

const sidebarStoragePrefix = "qintopia:pms:sidebar-collapsed:v1";

export function sidebarStorageKey(subjectId: string): string {
  return `${sidebarStoragePrefix}:${encodeURIComponent(subjectId)}`;
}

export function availableLocalStorage(owner: { readonly localStorage: Storage } | undefined): Storage | undefined {
  if (!owner) return undefined;
  try {
    return owner.localStorage;
  } catch {
    return undefined;
  }
}

function storedLocalValue(key: string): string | null {
  try {
    return availableLocalStorage(typeof window === "undefined" ? undefined : window)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function persistLocalValue(key: string, value: string): void {
  try {
    availableLocalStorage(typeof window === "undefined" ? undefined : window)?.setItem(key, value);
  } catch {
    // The workspace remains usable when browser storage is unavailable.
  }
}

export function storedSidebarCollapsed(storage: Pick<Storage, "getItem"> | undefined, subjectId: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(sidebarStorageKey(subjectId)) === "true";
  } catch {
    return false;
  }
}

export function persistSidebarCollapsed(storage: Pick<Storage, "setItem"> | undefined, subjectId: string, collapsed: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(sidebarStorageKey(subjectId), String(collapsed));
  } catch {
    // The navigation remains usable when browser storage is unavailable.
  }
}

function Navigation({ access, mobile = false, collapsed = false }: { access: "READ" | "WRITE"; mobile?: boolean; collapsed?: boolean }) {
  return (
    <nav className={mobile ? "mobile-navigation" : "primary-navigation"} aria-label={mobile ? "移动主导航" : "主导航"}>
      {navigationItemsForAccess(access).map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}
            title={!mobile && collapsed ? item.label : undefined}
            aria-label={!mobile && collapsed ? item.label : undefined}
          >
            <Icon aria-hidden="true" size={mobile ? 20 : 18} />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export function AppShell({ onLogout }: { onLogout: () => void }) {
  const { principal, meta, propertyId, setPropertyId } = useWorkspace();
  const property = meta.properties.find((item) => item.id === propertyId);
  const propertyAccess = principal.propertyAccess[propertyId] ?? "READ";
  const [logoutFailure, setLogoutFailure] = useState<{ error: unknown; sessionState: "ACTIVE" | "UNKNOWN" }>();
  const [loggingOut, setLoggingOut] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => storedSidebarCollapsed(
    availableLocalStorage(typeof window === "undefined" ? undefined : window),
    principal.subjectId
  ));
  const logoutErrorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (logoutFailure) logoutErrorRef.current?.focus();
  }, [logoutFailure]);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutFailure(undefined);
    try {
      await api.logout();
      onLogout();
    } catch (nextError) {
      let sessionState: "ACTIVE" | "UNKNOWN" = "UNKNOWN";
      try {
        await api.me();
        sessionState = "ACTIVE";
      } catch (verificationError) {
        if (verificationError instanceof ApiError && verificationError.status === 401) {
          onLogout();
          return;
        }
      }
      setLogoutFailure({ error: nextError, sessionState });
      setLoggingOut(false);
    }
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      persistSidebarCollapsed(availableLocalStorage(typeof window === "undefined" ? undefined : window), principal.subjectId, next);
      return next;
    });
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-is-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">跳至主要内容</a>
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <div className="sidebar-brand" aria-label="QinTopia PMS">
            <span className="brand-word"><span className="sidebar-brand-full">QinTopia</span><span className="sidebar-brand-compact" aria-hidden="true">Q</span></span>
            <span className="sidebar-brand-product">PMS</span>
          </div>
          <button
            className="icon-button sidebar-toggle"
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "展开左侧导航" : "收起左侧导航"}
            title={sidebarCollapsed ? "展开左侧导航" : "收起左侧导航"}
            aria-expanded={!sidebarCollapsed}
            data-testid="sidebar-toggle"
          >
            {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" size={18} /> : <PanelLeftClose aria-hidden="true" size={18} />}
          </button>
        </div>
        <Navigation access={propertyAccess} collapsed={sidebarCollapsed} />
        <div className="sidebar-user">
          <UserRound aria-hidden="true" size={18} />
          <div><strong>{principal.displayName}</strong><span>{principal.propertyAccess[propertyId] === "WRITE" ? "可写" : "只读"}</span></div>
          <button className="icon-button" type="button" onClick={() => void logout()} disabled={loggingOut} aria-label="退出登录" title="退出登录"><LogOut aria-hidden="true" size={18} /></button>
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-header">
          <div className="property-control">
            <Building2 aria-hidden="true" size={17} />
            <label className="sr-only" htmlFor="property-select">门店</label>
            <select id="property-select" value={propertyId} onChange={(event) => setPropertyId(event.target.value)} data-testid="property-select">
              {meta.properties.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
            </select>
          </div>
          <div className="property-meta"><span>{property?.timezone}</span><span>{property?.currency}</span></div>
          <button className="mobile-logout icon-button" type="button" onClick={() => void logout()} disabled={loggingOut} aria-label="退出登录" title="退出登录"><LogOut aria-hidden="true" size={19} /></button>
        </header>
        {logoutFailure ? (
          <section className="session-action-error" role="alert" tabIndex={-1} ref={logoutErrorRef} data-testid="logout-error">
            <AlertCircle aria-hidden="true" size={20} />
            <div>
              <strong>{logoutFailure.sessionState === "ACTIVE" ? "退出未完成，会话仍保持登录" : "退出结果暂未确认，本页面保持当前工作区"}</strong>
              <p>{errorMessage(logoutFailure.error)}</p>
            </div>
            <button className="button button-secondary" type="button" onClick={() => void logout()} disabled={loggingOut} data-testid="retry-logout">
              <RefreshCw aria-hidden="true" size={17} />重试退出
            </button>
          </section>
        ) : null}
        <main id="main-content" className="main-content" tabIndex={-1}><Outlet /></main>
      </div>
      <Navigation access={propertyAccess} mobile />
    </div>
  );
}
