import React, { useSyncExternalStore, type ReactNode } from 'react';
import './desktop-user.css';

export type DesktopUserShellProps = {
  route: string;
  section: string;
  open: (name: string) => void;
  children: ReactNode;
  enabled?: boolean;
};

const desktopQuery = '(min-width: 1000px)';
const logo = new URL('../../public/ui/logo-mark.png', import.meta.url).href;
function subscribeDesktop(listener: () => void) {
  if (typeof window === 'undefined') return () => {};
  const query = window.matchMedia(desktopQuery);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
const isDesktop = () => typeof window !== 'undefined' && window.matchMedia(desktopQuery).matches;

// Keep the App's thin, rounded line icons; each destination has its own shape.
const icons = {
  training: 'M3 10l9-7 9 7 M5 9v12h14V9 M9 21v-7h6v7',
  plans: 'M8 4H5v17h14V4h-3 M9 3h6v4H9z M8 11l1 1 2-2 M13 11h3 M8 16l1 1 2-2 M13 16h3',
  calendar: 'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M8 14h2 M14 14h2 M8 18h2',
  drafts: 'M5 3h10l4 4v14H5z M14 3v5h5 M8 12h6 M8 16h4',
  history: 'M4 4h6v6H4z M14 4h6v9h-6z M4 14h6v6H4z M14 17h6v3h-6z',
  records: 'M4 10a8 8 0 1 1 1 7 M4 4v6h6 M12 7v5l3 2',
  trends: 'M4 4v16h17 M7 15l4-5 4 2 5-7 M16 5h4v4',
  compare: 'M4 7h16 M16 3l4 4-4 4 M20 17H4 M8 13l-4 4 4 4',
  team: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M3 21v-3a6 6 0 0 1 12 0v3 M16 5a3 3 0 0 1 0 6 M18 14a4 4 0 0 1 3 4v3',
  news: 'M4 3h13v18H4z M17 7h4v12a2 2 0 0 1-2 2 M7 7h7 M7 11h7 M7 15h3 M7 18h7',
  profile: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 21v-2a8 8 0 0 1 16 0v2',
  score: 'M12 3a9 9 0 1 0 9 9 M12 7a5 5 0 1 0 5 5 M12 12l9-9 M16 3h5v5',
  coach: 'M4 4h16v11H4z M12 15v6 M8 21l4-3 4 3 M7 11l3-3 3 2 4-4',
  admin: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
} as const;
type IconName = keyof typeof icons;
function Icon({ name }: { name: IconName }) {
  return <svg className="desk-user-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={icons[name]} /></svg>;
}

type Destination = { name: string; label: string; icon: IconName; routes: readonly string[] };
const training: readonly Destination[] = [
  { name: 'training', label: '训练首页', icon: 'training', routes: ['training', 'motion'] },
  { name: 'plans', label: '计划', icon: 'plans', routes: ['plans', 'plan', 'plan-detail', 'program', 'programs'] },
  { name: 'calendar', label: '日历', icon: 'calendar', routes: ['calendar'] },
  { name: 'drafts', label: '草稿', icon: 'drafts', routes: ['drafts'] },
];
const review: readonly Destination[] = [
  { name: 'history', label: '复盘总览', icon: 'history', routes: ['history'] },
  { name: 'history-all', label: '历史', icon: 'records', routes: ['history-all', 'insights', 'detail', 'reflection', 'report', 'group'] },
  { name: 'trends', label: '趋势', icon: 'trends', routes: ['trends'] },
  { name: 'compare', label: '对比', icon: 'compare', routes: ['compare'] },
];
const personal: readonly Destination[] = [
  { name: 'team', label: '我的团队', icon: 'team', routes: ['team'] },
  { name: 'news', label: '资讯', icon: 'news', routes: ['news', 'community'] },
  { name: 'profile', label: '个人', icon: 'profile', routes: ['profile', 'settings', 'personal', 'support', 'feedback', 'rewards', 'announcements', 'equipment-list', 'equipment', 'accessories', 'accessory', 'goals', 'goal', 'targets', 'target', 'account', 'legacy-account', 'data', 'about', 'guide', 'intro', 'promotion'] },
];

export function DesktopUserShell({ route, section, open, children, enabled = true }: DesktopUserShellProps) {
  const wide = useSyncExternalStore(subscribeDesktop, isDesktop, () => false);
  if (!enabled) return <>{children}</>;
  const current = route.replace(/^\/?#?\/?/, '').split(/[?/:]/)[0];
  const sectionLabel = current === 'team' ? '我的团队' : current === 'score' ? '训练记分' : ({ training: '训练', history: '复盘', news: '资讯', profile: '个人' } as Record<string, string>)[section] || '个人训练';
  const item = (destination: Destination) => <button key={destination.name} type="button" className="desk-user-nav-item" aria-current={destination.routes.includes(current) ? 'page' : undefined} onClick={() => open(destination.name)}><Icon name={destination.icon} /><span>{destination.label}</span></button>;

  // Only the chrome changes at the breakpoint. Children retain the same parent,
  // so resizing does not remount a score entry or discard an unsaved form.
  return <div className="desk-user" data-route={current} data-section={section}>
    <aside className="desk-user-sidebar" hidden={!wide} aria-label="桌面导航">
      <button type="button" className="desk-user-brand" onClick={() => open('training')} aria-label="弓行记，训练首页"><img src={logo} width="38" height="38" alt="" /><span><strong>弓行记</strong><small>个人训练</small></span></button>
      <nav className="desk-user-nav" aria-label="用户端功能">
        <div className="desk-user-nav-group"><h2>训练</h2>{training.map(item)}</div>
        <div className="desk-user-nav-group"><h2>复盘</h2>{review.map(item)}</div>
        <div className="desk-user-nav-group desk-user-personal-nav">{personal.map(item)}</div>
      </nav>
      <nav className="desk-user-roles" aria-label="其他工作台"><h2>工作台</h2><button type="button" className="desk-user-nav-item" onClick={() => open('/coach')}><Icon name="coach" /><span>教练端</span><span className="desk-user-entry-arrow" aria-hidden="true">›</span></button></nav>
    </aside>
    <div className="desk-user-frame">
      <header className="desk-user-topbar" hidden={!wide}><div className="desk-user-topbar-inner"><div className="desk-user-location"><span>个人训练</span><span aria-hidden="true">/</span><strong>{sectionLabel}</strong></div><button type="button" className="desk-user-score" aria-current={current === 'score' ? 'page' : undefined} onClick={() => open('score')}><Icon name="score" /><span>进入记分</span></button></div></header>
      {children}
    </div>
  </div>;
}
