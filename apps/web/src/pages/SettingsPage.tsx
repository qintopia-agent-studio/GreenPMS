import { Suspense } from "react";
import { BedDouble, KeyRound, Settings, Users } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { canManageTokens, principalCan, useWorkspace } from "../session";
import { LoadingBlock } from "../uiBasic";

export function SettingsPage() {
  const { principal, propertyId } = useWorkspace();
  const { pathname } = useLocation();
  const index = pathname === "/settings" || pathname === "/settings/";
  return <div className="settings-page">
    <nav className="settings-tabs" aria-label="设置导航">
      <NavLink to="/settings" end className="settings-link"><Settings aria-hidden="true" size={18} /><span>设置总览</span></NavLink>
      <NavLink to="/settings/accounts" className="settings-link"><Users aria-hidden="true" size={18} /><span>账号</span></NavLink>
      {canManageTokens(principal, propertyId) ? <NavLink to="/settings/tokens" className="settings-link"><KeyRound aria-hidden="true" size={18} /><span>外部访问</span></NavLink> : null}
      {principalCan(principal, propertyId, "MANAGE_ROOM_CATALOG") ? <NavLink to="/settings/rooms" className="settings-link"><BedDouble aria-hidden="true" size={18} /><span>房型与价格</span></NavLink> : null}
    </nav>
    {index ? <header className="page-heading settings-page-heading"><div><p className="eyebrow">系统管理</p><h1>设置</h1><p className="muted">通过上方导航管理账号及当前门店可用的设置。</p></div></header> : null}
    <Suspense fallback={<LoadingBlock label="正在载入设置内容" />}><Outlet /></Suspense>
  </div>;
}
