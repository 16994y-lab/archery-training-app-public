import { useState } from "react";
import type { ReactNode } from "react";
import { useModelPreview } from "./ModelPreview";
import type { ScoreSession } from "../../scoring-session";

export function ActualGroupScores({ session, disabled, onSelect }: { session: ScoreSession; disabled: boolean; onSelect(end: number, arrow?: number): void }) {
  return <section className="alignment-card actual-group-scores"><SectionHeading title="每组成绩"/><DataNotice>逐箭按录入顺序展示，不代表出箭顺序。点选进入本组校正。</DataNotice>{session.ends.map(end=><div className="actual-end-row" key={end.sequence}><button className="actual-end-heading" disabled={disabled} onClick={()=>onSelect(end.sequence)}>第{end.sequence}组 <span>查看／修改 ›</span></button><div className="actual-arrow-codes">{end.arrows.map(a=><button disabled={disabled} aria-label={`查看第${end.sequence}组第${a.sequence}箭 ${a.score_code}`} key={a.id} onClick={()=>onSelect(end.sequence,a.sequence)}>{a.score_code}</button>)}</div><div className="actual-end-total"><small>{end.arrows.length}箭</small><strong>{end.summary.total_score}分</strong></div></div>)}</section>;
}

export function FeatureLink({ title, detail, section, children }: { title: string; detail: string; section: string; children?: ReactNode }) {
  const { open } = useModelPreview();
  return <button className="alignment-feature" onClick={() => open(section)}><span><strong>{title}</strong><small>{detail}</small></span><span className="feature-status">示例 ›</span>{children}</button>;
}
export function SectionHeading({ title, children }: { title: string; children?: ReactNode }) { return <div className="alignment-section-heading"><h2>{title}</h2>{children}</div>; }
export function DataNotice({ children }: { children: ReactNode }) { return <p className="alignment-data-note">{children}</p>; }
export const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;

/** Confirmation dates are not silently re-labelled as actual training dates. */
export function RecordCalendar({ dates = [], kind = "history", onSelect }: { dates?: string[]; kind?: "history" | "plan"; onSelect?(date: string): void }) {
  const now = new Date(), [month, setMonth] = useState(new Date(now.getFullYear(), now.getMonth(), 1)), [selected, setSelected] = useState<string | null>(null);
  const days = new Date(month.getFullYear(), month.getMonth()+1,0).getDate(), offset=(month.getDay()+6)%7, keys=new Set(dates);
  const move=(delta:number)=>setMonth(new Date(month.getFullYear(),month.getMonth()+delta,1));
  return <section className="alignment-card alignment-calendar"><SectionHeading title={kind === "history" ? "训练记录日历" : "计划日历"} /><div className="calendar-month"><button aria-label="上个月" onClick={()=>move(-1)}>‹</button><strong>{month.getFullYear()}年{month.getMonth()+1}月</strong><button aria-label="下个月" onClick={()=>move(1)}>›</button></div><div className="calendar-days">{["一","二","三","四","五","六","日"].map(d=><small key={d}>{d}</small>)}{Array.from({length:offset},(_,i)=><span key={`blank-${i}`} />)}{Array.from({length:days},(_,i)=>{const key=dateKey(new Date(month.getFullYear(),month.getMonth(),i+1));return <button key={key} aria-label={`${key}${keys.has(key)?" 有已确认记录":""}`} aria-pressed={selected===key} className={`${key===dateKey(now)?"is-today":""} ${keys.has(key)?"has-record":""}`} onClick={()=>{setSelected(key);onSelect?.(key);}}>{i+1}<i aria-hidden="true" /></button>;})}</div><DataNotice>{kind==="history"?"按记录确认日期显示；不把确认时间当作实际开练时间。":"未来排程尚未接入；不会把示例安排写入你的计划。"}</DataNotice>{selected&&<p className="calendar-selection">{selected} · {kind==="plan"?"可查看完整排程示例":keys.has(selected)?"下方显示当天已确认记录":"当天没有已确认记录"}</p>}</section>;
}
export function TrainingExtensions() {
  const {open}=useModelPreview();
  return <><div className="alignment-features training-shortcuts"><FeatureLink title="长期训练计划" detail="周期 · 每周安排" section="cycle"/><FeatureLink title="我的训练目标" detail="箭量 · 频次 · 阶段进度" section="goals"/><FeatureLink title="视频动作教练" detail="拍摄／导入 · 尚未接入" section="video"/><FeatureLink title="保存与恢复" detail="完整恢复流程示意" section="systems"/></div><RecordCalendar kind="plan"/><button className="alignment-wide" onClick={()=>open("cycle")}>安排训练 · 查看日历排程示例</button><section className="alignment-card"><SectionHeading title="训练工具"/><div className="alignment-features"><FeatureLink title="常用器材套组" detail="选择套组 · 新建与编辑配件" section="kits"/><FeatureLink title="休息与计时" detail="分段安排 · 实际休息记录" section="reminder"/><FeatureLink title="靶面与训练编排" detail="靶型尺寸 · 自建同心圆 · 拖动编排" section="builder"/></div></section></>;
}
export function ReviewExtensions() {
  return <section className="alignment-card"><SectionHeading title="深度复盘"/><DataNotice>以下完整页面使用单独的示例数据，不替代上方真实统计。</DataNotice><div className="alignment-features"><FeatureLink title="长期分析与条件对比" detail="时间范围 · 成绩比例 · 偏向与散布" section="analytics"/><FeatureLink title="体能与疲劳观察" detail="主观自评 · 分组变化 · 不作诊断" section="fatigue"/><FeatureLink title="调整下次训练" detail="保留历史 · 修改未来安排" section="next"/><FeatureLink title="报告导出与分享预览" detail="选择内容 · 姓名与心得隐私开关" section="export"/></div></section>;
}
export function MyOverview({ email, authenticated, queued, children }: { email: string | null; authenticated: boolean; queued: number; children: ReactNode }) {
  const {open}=useModelPreview();
  return <main className="aligned-my"><header className="alignment-heading figma-page-heading"><div className="heading-lockup"><span className="page-logo"><img src="/ui/logo-mark.png" alt="" /></span><div><p className="eyebrow">弓行记 · 个人训练空间</p><h1>我的</h1></div></div><button onClick={()=>open("mine")}>完整资料示例</button></header><section className="alignment-profile"><div className="profile-mark" aria-hidden="true"><img src="/ui/logo-mark.png" alt="" /></div><div><h2>{authenticated?"我的训练空间":"独立训练者"}</h2><p>{email||"为每一次专注，留下依据"}</p><small>{authenticated?"已登录":"尚未登录"} · {queued?`${queued}条待同步`:"真实记录与功能示例分开"}</small></div></section><section className="alignment-card"><SectionHeading title="训练资料与偏好"/><FeatureLink title="个人训练资料" detail="弓种 · 距离偏好 · 训练经历" section="mine"/><FeatureLink title="我的训练目标" detail="阶段目标 · 计划箭量 · 频次" section="goals"/><FeatureLink title="常用器材套组" detail="反曲弓配件 · 新建套组 · 配置详情" section="kits"/></section><section className="alignment-card"><SectionHeading title="数据与手机能力"/><FeatureLink title="权限与系统能力" detail="相机 · 视频 · 本地存储 · 后台提醒" section="systems"/><DataNotice>尚未接入的权限仅解释用途，不弹假授权，也不显示假同步成功。</DataNotice></section><section className="alignment-account-live"><SectionHeading title="账户与真实数据管理"/>{children}</section><section className="alignment-card"><SectionHeading title="帮助与关于"/><p>个人射箭训练 · 浅色移动端版本</p><DataNotice>新手指引、完整异常引导与深色模式保持延期。</DataNotice><button onClick={()=>open("entry")}>浏览完整功能示例</button></section></main>;
}
