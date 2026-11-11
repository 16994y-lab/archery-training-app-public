import {useEffect, useState} from 'react';
import {Button, Modal, Panel, useApp} from './ui';

type UpdateBridge = {
  appUpdateStatus(): string;
  checkAppUpdate(): void;
  downloadAppUpdate(): void;
  installAppUpdate(): void;
  exitAppForUpdate?(): void;
};

type UpdateState = {
  phase: string;
  current: string;
  version: string;
  bytes: number;
  progress: number;
  versionCode?: number;
  mandatory?: boolean;
  notes?: string[];
};

const updateEvent = 'gongxingji-app-update';
const openEvent = 'gongxingji-show-app-update';

const notices: Record<string, string> = {
  idle: '可联网检查更新。',
  checking: '正在检查正式版本…',
  current: '已是最新正式版。',
  available: '可在应用内下载，下载后由 Android 确认安装。',
  ready: '安装包已核验。确认安装后，Android 会覆盖更新当前应用。',
  settings: '请在系统设置中允许弓行记安装应用，再返回此处。',
  permissionNeeded: '尚未获得安装权限。可重新打开设置，允许来自弓行记的安装。',
  installing: '请在 Android 安装界面确认。',
  installReturned: '安装界面已返回，可以重新打开安装。',
  checkFailed: '暂时无法检查更新，请联网后重试。',
  downloadFailed: '下载或核验未完成，请检查网络和可用空间后重试。',
  installFailed: '无法打开系统安装界面，请重试。',
};

function nativeBridge() {
  const bridge = window.Gongxingji as (typeof window.Gongxingji & Partial<UpdateBridge>);
  return typeof bridge?.appUpdateStatus === 'function' ? bridge as UpdateBridge : null;
}

function useAppUpdate() {
  const bridge = nativeBridge();
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    if (!bridge) return;
    const sync = () => {
      try {
        const value = JSON.parse(bridge.appUpdateStatus()) as Partial<UpdateState>;
        setState(typeof value.phase === 'string' && typeof value.current === 'string' ? value as UpdateState : null);
      } catch {
        setState(null);
      }
    };
    window.addEventListener(updateEvent, sync);
    sync();
    return () => window.removeEventListener(updateEvent, sync);
  }, [bridge]);
  return {bridge, state};
}

export function AppUpdatePanel() {
  const {bridge, state} = useAppUpdate();
  if (!bridge || !state) return null;
  return <Panel title="软件更新">
    <p>当前版本 {state.current}</p>
    <p role="status">{state.version ? `发现弓行记 ${state.version}` : notices[state.phase]}</p>
    {state.version
      ? <Button onClick={() => window.dispatchEvent(new Event(openEvent))}>查看更新</Button>
      : <Button disabled={state.phase === 'checking'} onClick={() => bridge.checkAppUpdate()}>检查更新</Button>}
  </Panel>;
}

export function AppUpdateNotice() {
  const {bridge, state} = useAppUpdate();
  const {hasPendingSave, tell} = useApp();
  const [dismissed, setDismissed] = useState<string | number | null>(null);
  useEffect(() => {
    const show = () => setDismissed(null);
    window.addEventListener(openEvent, show);
    return () => window.removeEventListener(openEvent, show);
  }, []);

  if (!bridge || !state?.version || hasPendingSave()) return null;
  const {phase, current, version, bytes} = state;
  const updateKey = state.versionCode || version;
  const required = state.mandatory === true && typeof bridge.exitAppForUpdate === 'function';
  if (!required && dismissed === updateKey) return null;
  const notes = Array.isArray(state.notes) ? state.notes.filter(note => typeof note === 'string') : [];
  const check = phase === 'checkFailed';
  const download = phase === 'available' || phase === 'downloadFailed';
  const install = ['ready', 'permissionNeeded', 'installReturned', 'installFailed'].includes(phase);
  const close = () => {
    if (required) {
      if (hasPendingSave()) {
        tell('请先完成当前保存');
        return;
      }
      bridge.exitAppForUpdate?.();
    } else {
      setDismissed(updateKey);
    }
  };
  const requestInstall = () => {
    if (hasPendingSave()) {
      tell('请先保存当前训练，再安装更新');
      return;
    }
    bridge.installAppUpdate();
  };

  const title = `弓行记 ${version} 更新`;
  if (phase === 'downloading') {
    const progress = Number.isFinite(state.progress) ? Math.round(Math.min(100, Math.max(0, state.progress))) : 0;
    return <Modal title={title} onClose={close}>
      <progress aria-label="更新下载进度" value={progress} max={100} style={{display:'block', width:'100%', accentColor:'var(--adm-color-primary)'}}/>
      <p role="status" style={{textAlign:'center'}}>{progress}%</p>
    </Modal>;
  }

  return <Modal title={title} onClose={close}>
    <p>当前版本 {current} · 更新包 {(bytes / 1024 / 1024).toFixed(1)} MB</p>
    {required && <p>请更新后继续使用。关闭提示将退出应用。</p>}
    <section aria-label="本版更新内容">
      <h3>本版更新内容</h3>
      {notes.length ? <ul>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : <p>此版本未提供更新说明。</p>}
    </section>
    <p role="status">{notices[phase]}</p>
    <div className="modal-actions">
      <Button onClick={close}>{required ? '退出应用' : '稍后更新'}</Button>
      {check && <Button kind="primary" onClick={() => bridge.checkAppUpdate()}>重新检查</Button>}
      {download && <Button kind="primary" onClick={() => bridge.downloadAppUpdate()}>{phase === 'downloadFailed' ? '重新下载' : '下载更新'}</Button>}
      {install && <Button kind="primary" onClick={requestInstall}>{phase === 'permissionNeeded' ? '打开安装设置' : '安装更新'}</Button>}
    </div>
  </Modal>;
}
