import type { ReactNode } from "react";
import { useModelPreview } from "../features/model-alignment/ModelPreview";

export type AppPage = "community" | "home" | "plans" | "scoring" | "history" | "account";

export const APP_NAV_ITEMS: ReadonlyArray<Readonly<{ page: AppPage; label: string; icon: string; activeIcon: string }>> = [
  { page: "community", label: "社区", icon: "/ui/nav-community.svg", activeIcon: "/ui/nav-community-active.svg" },
  { page: "home", label: "训练", icon: "/ui/nav-training.svg", activeIcon: "/ui/nav-training-active.svg" },
  { page: "scoring", label: "记分", icon: "/ui/nav-score.svg", activeIcon: "/ui/nav-score-active.svg" },
  { page: "history", label: "复盘", icon: "/ui/nav-review.svg", activeIcon: "/ui/nav-review-active.svg" },
  { page: "account", label: "我的", icon: "/ui/nav-account.svg", activeIcon: "/ui/nav-account-active.svg" },
];

export function AppShell({ active, queued = 0, onNavigate, children }: { active: AppPage; queued?: number; onNavigate(page: AppPage): void; children: ReactNode }) {
  const { open } = useModelPreview();
  return <div className="app-shell">
    <aside className="desktop-rail">
      <button className="brand-lockup" aria-label="返回首页" onClick={() => onNavigate("home")}><img className="brand-mark" src="/ui/logo-mark.png" alt="" /><span>弓行记</span></button>
      <AppNavigation active={active} queued={queued} onNavigate={onNavigate} />
    </aside>
    <div className="app-stage">{active !== "scoring" && <div className="alignment-source-bar"><span>我的记录 · 真实数据</span><button onClick={()=>open(active==="history"?"review":active==="account"?"mine":active==="community"?"community":"entry")}>完整功能示例 ↗</button></div>}{children}</div>
    <AppNavigation mobile active={active} queued={queued} onNavigate={onNavigate} />
  </div>;
}

function AppNavigation({ active, queued, onNavigate, mobile = false }: { active: AppPage; queued: number; mobile?: boolean; onNavigate(page: AppPage): void }) {
  const selected = active === "plans" ? "home" : active;
  return <nav className={mobile ? "app-nav mobile-nav" : "app-nav rail-nav"} aria-label="主导航">
    {mobile && <img className="mobile-nav-dock" src="/ui/bottom-nav-dock.svg" alt="" aria-hidden="true" />}
    {APP_NAV_ITEMS.map((item) => <button key={item.page} type="button" aria-current={selected === item.page ? "page" : undefined} className={`${selected === item.page ? "active" : ""} ${item.page === "scoring" ? "score-entry" : ""}`} onClick={() => onNavigate(item.page)}>
      <span className="nav-icon" aria-hidden="true"><img src={selected === item.page ? item.activeIcon : item.icon} alt="" /></span><b>{item.label}</b>{item.page === "account" && queued > 0 ? <em>{queued}</em> : null}
    </button>)}
  </nav>;
}
