import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/noto-sans-sc";
import "./styles.css";

const StaffApp = React.lazy(() => import("./App"));
const MemberCenter = React.lazy(() => import("./pages/MemberCenterPage"));
const memberPath = /^\/member-center\/?$/.test(window.location.pathname);
if (memberPath && (window.location.pathname !== "/member-center" || window.location.search)) {
  window.location.replace("/member-center" + window.location.hash);
} else {
  createRoot(document.getElementById("root")!).render(<React.StrictMode><React.Suspense fallback={<p role="status">正在打开…</p>}>
    {memberPath ? <MemberCenter /> : <StaffApp />}
  </React.Suspense></React.StrictMode>);
}
