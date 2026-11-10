import type { ScoreSession } from "../scoring-session";
import { useState } from "react";
import { TrainingExtensions } from "../features/model-alignment/AlignedPages";
import { useModelPreview } from "../features/model-alignment/ModelPreview";

export function TrainingHome({ resume, planCount, error, onStart, onPlans, onReview }: { resume: ScoreSession | null; planCount: number; error: string; onStart(): void; onPlans(): void; onReview(): void }) {
  const [choosing, setChoosing] = useState(false);
  const { open } = useModelPreview();
  const recordedArrows = resume?.ends.reduce((total, end) => total + end.arrows.length, 0) ?? 0;
  const plannedArrows = resume ? resume.planned_end_count * resume.arrows_per_end : null;
  return <main className="training-home"><header className="training-heading figma-page-heading"><div className="heading-lockup"><span className="page-logo"><img src="/ui/logo-mark.png" alt="" /></span><div><p className="eyebrow">训练 · 今日计划</p><h1 aria-label="训练">把每一箭，练成稳定</h1></div></div><span className="training-date">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</span></header>
    {error && <p className="notice error" role="alert">{error}</p>}
    <section className="training-hero motion-metric-card"><div className="metric-topline"><span>{resume ? "本次进度" : "训练准备"}</span><span className="metric-status">{resume ? `第 ${resume.ends.filter(end => end.status === "CONFIRMED").length + 1} 组` : `${planCount} 个可用计划`}</span></div><div className="motion-metric-value"><strong>{resume ? recordedArrows : planCount}</strong><span>{resume && plannedArrows !== null ? `/ ${plannedArrows}` : "个"}</span></div><p>{resume ? `${resume.distance_m} 米 · ${resume.target.name} · 记录随每箭保存` : planCount ? "选择一个已有计划，开始今天的练习。" : "先建立第一份可复用训练计划。"}</p></section>
    <button className="primary training-primary-action" onClick={resume ? onStart : ()=>setChoosing(true)}>{resume ? "继续本次训练" : "开始训练"}</button>
    {choosing && <div className="alignment-dialog-backdrop"><section className="alignment-dialog" role="dialog" aria-modal="true" aria-label="选择训练方式"><h2>{resume?"已有训练正在进行":"这次怎么训练？"}</h2><p>{resume?"当前记录会保留。你可以继续当前训练，或先浏览计划与临时训练示例；这里不会放弃或覆盖当前记录。":"有计划就按计划开始，临时训练先体验完整流程。"}</p>{resume&&<button className="primary" onClick={()=>{setChoosing(false);onStart();}}>继续当前训练</button>}<button className="alignment-feature" onClick={()=>{setChoosing(false);onPlans();}}><span><strong>训练计划</strong><small>选择已有计划或新建 · 真实保存</small></span><span>›</span></button><button className="alignment-feature" onClick={()=>{setChoosing(false);open("quick");}}><span><strong>临时训练</strong><small>靶型与距离 → 直接录入 · 示例，不保存</small></span><span>›</span></button><button onClick={()=>setChoosing(false)}>取消</button></section></div>}
    {resume && <section className="resume"><div><strong>有一场训练尚未结束</strong><p>{resume.distance_m}米 · {resume.target.name}<br />已录 {recordedArrows} 箭 · 保存状态以记分提示为准</p></div><button onClick={onStart}>继续</button></section>}
    {resume && <button className="alignment-wide" onClick={()=>setChoosing(true)}>开始另一场训练 · 查看选择</button>}
    <TrainingExtensions />
    <section className="training-links"><button aria-label="选择训练计划" onClick={onPlans}><span className="list-icon" aria-hidden="true">计</span><span><strong>可复用计划</strong><small>{planCount}个可用计划 · 调整后开始</small></span><span aria-hidden="true">›</span></button><button onClick={onReview}><span className="list-icon" aria-hidden="true">复</span><span><strong>记录与复盘</strong><small>从已确认的成绩看见变化</small></span><span aria-hidden="true">›</span></button></section>
  </main>;
}
