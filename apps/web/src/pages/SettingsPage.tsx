import { BedDouble, KeyRound, Users } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { canManageTokens, principalCan, useWorkspace } from "../session";

export function SettingsPage() {
  const { principal, propertyId } = useWorkspace();
  const { pathname } = useLocation();
  const index = pathname === "/settings" || pathname === "/settings/";
  return <div className="settings-page">
    {index ? <header className="page-heading settings-page-heading"><div><p className="eyebrow">系统管理</p><h1>设置</h1></div></header> : null}
    <nav className={index ? "settings-cards" : "settings-tabs"} aria-label="设置导航">
      {principalCan(principal, propertyId, "MANAGE_ROOM_CATALOG") ? <NavLink to="/settings/rooms" className="settings-link"><BedDouble aria-hidden="true" size={20} /><span><strong>房型与价格</strong>{index ? <small>房型、房间床位与住宿价格</small> : null}</span></NavLink> : null}
      <NavLink to="/settings/accounts" className="settings-link"><Users aria-hidden="true" size={20} /><span><strong>账号</strong>{index ? <small>工作人员、门店授权与操作权限</small> : null}</span></NavLink>
      {canManageTokens(principal, propertyId) ? <NavLink to="/settings/tokens" className="settings-link"><KeyRound aria-hidden="true" size={20} /><span><strong>外部访问</strong>{index ? <small>访问密钥、权限范围与有效期</small> : null}</span></NavLink> : null}
    </nav>
    <Outlet />
  </div>;
}
