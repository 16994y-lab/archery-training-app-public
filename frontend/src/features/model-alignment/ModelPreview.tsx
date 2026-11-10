import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { modelMarkup } from "./model-markup";
import { mountModelRuntime } from "./model-runtime";

type PreviewContext = { open(section?: string): void; guard: MutableRefObject<() => boolean> };
const Context = createContext<PreviewContext | null>(null);
export function useModelPreview() { const value = useContext(Context); if (!value) throw new Error("Missing presentation context"); return value; }

/** The preserved model is a source module, not an iframe or a second external site.
 * No API, account, queue or real-record object is passed into its memory state. */
export function AlignedExperience({ children }: { children: ReactNode }) {
  const [section, setSection] = useState<string | null>(null);
  const guard = useRef(() => true);
  return <Context.Provider value={{ guard, open: (next = "entry") => { if (guard.current()) setSection(next); } }}>
    <div hidden={section !== null}>{children}</div>
    {section !== null && <Preview section={section} onClose={() => setSection(null)} />}
  </Context.Provider>;
}
function Preview({ section, onClose }: { section: string; onClose(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<ReturnType<typeof mountModelRuntime> | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  useEffect(() => {
    const node = host.current!, shadow = node.shadowRoot ?? node.attachShadow({ mode: "open" });
    shadow.innerHTML = modelMarkup;
    const css = document.createElement("style");
    css.textContent = `#archery-mobile-v10{color-scheme:light!important}#archery-mobile-v10 .m-phone{width:100%;height:calc(100svh - 44px);margin:0;border:0;border-radius:0;box-shadow:none;grid-template-rows:minmax(0,1fr) 62px;position:relative}#archery-mobile-v10 .m-status{display:none}#archery-mobile-v10 .m-screen{overscroll-behavior:contain}#archery-mobile-v10 .m-score{height:auto;min-height:100%;gap:6px}#archery-mobile-v10 .m-score .m-target-block{flex:none;min-height:0}#archery-mobile-v10 .m-score .m-canvas{height:auto!important;width:100%;max-height:none;aspect-ratio:1;flex:none}#archery-mobile-v10 .m-canvas svg{width:100%;height:100%;max-height:none}#archery-mobile-v10 .m-context{background:linear-gradient(115deg,#edf6f7,#e5eef8)}#archery-mobile-v10 .m-primary{background:#216b7c;color:white}#archery-mobile-v10 .m-report-scatter{max-height:none}#archery-mobile-v10 .m-note10{border-left:3px solid #16877b;background:#edf7f3}#archery-mobile-v10 .m-cluster-details p{padding:10px;background:#f3f7fb;border-radius:12px}`;
    shadow.append(css);
    const instance = mountModelRuntime(shadow);
    runtime.current = instance; instance.open(section);
    return () => { instance.dispose(); runtime.current = null; };
  }, [section]);
  return <section className="model-preview" aria-label="完整功能示例">
    <header className="preview-boundary"><div><strong>体验数据 · 不保存到个人记录</strong></div><button onClick={() => runtime.current?.hasUnsaved() ? setConfirmExit(true) : onClose()}>返回我的记录</button></header>
    {confirmExit && <div className="alignment-dialog-backdrop"><section className="alignment-dialog" role="dialog" aria-modal="true" aria-label="离开示例确认"><h2>还有示例训练未结束</h2><p>离开将清除本次示例内容，不影响你的真实记录或草稿。</p><div className="actions"><button onClick={() => setConfirmExit(false)}>继续示例</button><button onClick={onClose}>离开并清空示例</button></div></section></div>}
    <div ref={host} />
  </section>;
}
