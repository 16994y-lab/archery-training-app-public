import React, {useRef, useState} from 'react';
import {List} from 'antd-mobile';
import {AppIcon, type AppIconName} from './AppIcon';
import {inspectBackup, mergeBackup, planBackupMerge, type BackupMergePlan, type BackupMergeReport} from './backup';
import {ChoiceSelect} from './ChoiceSelect';
import {copy, initialData, type Data} from './domain';
import {FirstBatchHeader} from './FirstBatchHeader';
import {validNickname} from './profile-local';
import {ProfileAvatar} from './ProfilePages';
import {ActionListItem, Back, Button, Field, Panel, useApp, useEditGuard} from './ui';
import './offline-profile.css';

type MenuItem = {label: string; description: string; icon: AppIconName; route: string};

function ProfileMenu({title, items}: {title: string; items: readonly MenuItem[]}) {
  const {open} = useApp();
  return <>
    <h2 className="profile-section-title">{title}</h2>
    <List className="entry-list profile-menu">
      {items.map(item => <ActionListItem
        key={item.route}
        prefix={<span className="profile-menu-icon"><AppIcon name={item.icon}/></span>}
        description={item.description}
        onClick={() => open(item.route)}>
        {item.label}
      </ActionListItem>)}
    </List>
  </>;
}

const personal: MenuItem = {label: '个人资料', description: '头像、用户名、弓种与介绍', icon: 'person', route: 'personal'};
const localData: MenuItem = {label: '数据管理', description: '备份文本、恢复预览与本机保存', icon: 'data', route: 'data'};
const account: MenuItem = {label: '账号中心', description: '离线开发版仅使用本机资料', icon: 'shield', route: 'account'};
const guide: MenuItem = {label: '使用指南', description: '训练、记分、复盘与本机备份', icon: 'book', route: 'guide'};
const about: MenuItem = {label: '关于与设备能力', description: '离线开发版 · 查看可用能力', icon: 'info', route: 'about'};

export function OfflineProfileHome() {
  const {data, open} = useApp();
  const {profile} = data;
  return <div className="gx-profile offline-profile">
    <div className="profile-topbar">
      <span className="gx-section-label">个人训练</span>
      <button type="button" className="profile-settings-button" aria-label="设置" onClick={() => open('settings')}>
        <AppIcon name="settings"/><span>设置</span>
      </button>
    </div>
    <FirstBatchHeader
      eyebrow="我的 / 个人资料"
      title={<button type="button" className="profile-name-button" aria-label="编辑个人资料" onClick={() => open('personal')}>
        <span className="profile-name-label">{profile.name || '设置你的用户名'}</span>
        <span aria-hidden="true">›</span>
      </button>}
      description={profile.bow || '个人资料'}
      meta={<span className="offline-profile-badge">离线开发版</span>}
      leading={<button type="button" className="profile-avatar-button" aria-label="更换本机头像" onClick={() => open('personal')}>
        <ProfileAvatar name={profile.name} avatar={profile.avatar}/>
      </button>}/>
    <div className="gx-profile-columns">
      <section>
        <ProfileMenu title="训练资料" items={[
          personal,
          {label: '训练目标', description: `${data.goals.length} 项目标 · 查看实际进度`, icon: 'target', route: 'goals'},
          {label: '器材与配件', description: `${data.equipment.length} 套器材 · 常用配件`, icon: 'kit', route: 'equipment-list'},
          {label: '自建靶面', description: '自建同心圆与规则修订', icon: 'target', route: 'targets'},
        ]}/>
        <ProfileMenu title="团队训练" items={[
          {label: '我的团队', description: '团队与成绩共享需联网服务', icon: 'person', route: 'team'},
        ]}/>
      </section>
      <section>
        <ProfileMenu title="账号与数据" items={[
          account, localData,
          {label: '邀请与特别伙伴', description: '离线版暂未接入邀请服务', icon: 'person', route: 'rewards'},
          {label: '公告与版本说明', description: '查看离线版能力', icon: 'info', route: 'announcements'},
        ]}/>
        <ProfileMenu title="帮助与关于" items={[guide, about]}/>
      </section>
    </div>
  </div>;
}

export function OfflineProfileSettings({onBack}: {onBack: () => void}) {
  return <div className="offline-profile">
    <Back title="设置" onBack={onBack}/>
    <ProfileMenu title="本机资料" items={[personal, localData, account]}/>
    <ProfileMenu title="帮助与关于" items={[guide, about]}/>
  </div>;
}

const avatarStyles = [
  {value: 'initial', label: '姓名首字'}, {value: 'bow', label: '弓箭'},
  {value: 'target', label: '靶面'}, {value: 'star', label: '星星'},
];

export function OfflinePersonalProfile({onBack}: {onBack: () => void}) {
  const {data, update} = useApp();
  const [draft, setDraft] = useState(() => copy({...data.profile, avatar: data.profile.avatar ?? 'initial'}));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const guard = useEditGuard(draft);
  const change = (key: keyof typeof draft, value: string) => setDraft(previous => ({...previous, [key]: value}));

  async function save() {
    if (inFlight.current) return;
    setError('');
    let name: string;
    try {
      name = draft.name.trim() ? validNickname(draft.name) : '';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请核对用户名。');
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const saved = await update(current => { current.profile = {...draft, name}; });
      if (saved) {
        guard.saved();
        onBack();
      } else setError('个人资料尚未保存，请重试。');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return <div className="offline-profile">
    <Back title="个人资料" dirty={guard.dirty} onBack={() => { if (!saving) void guard.close(onBack); }}/>
    <Panel>
      <form className="app-form" onSubmit={event => {event.preventDefault(); void save();}}>
        <div className="profile-avatar-preview">
          <ProfileAvatar name={draft.name} avatar={draft.avatar}/>
          <span>头像与资料保存在这台设备。</span>
        </div>
        <Field label="本机头像">
          <ChoiceSelect value={draft.avatar} disabled={saving} onChange={event => change('avatar', event.target.value)}>
            {avatarStyles.map(style => <option key={style.value} value={style.value}>{style.label}</option>)}
          </ChoiceSelect>
        </Field>
        <Field label="用户名">
          <input className="offline-profile-input" maxLength={100} value={draft.name} disabled={saving}
            onChange={event => change('name', event.target.value)} autoComplete="nickname"/>
        </Field>
        <Field label="主要弓种">
          <ChoiceSelect value={draft.bow} disabled={saving} onChange={event => change('bow', event.target.value)}>
            {[...new Set(['反曲弓', '复合弓', '光弓', '传统弓', '其他', draft.bow])].filter(Boolean)
              .map(bow => <option key={bow}>{bow}</option>)}
          </ChoiceSelect>
        </Field>
        <Field label="持弓手">
          <ChoiceSelect value={draft.hand} disabled={saving} onChange={event => change('hand', event.target.value)}>
            <option value="">未填写</option>
            {[...new Set(['左手持弓', '右手持弓', draft.hand])].filter(Boolean).map(hand => <option key={hand}>{hand}</option>)}
          </ChoiceSelect>
        </Field>
        <Field label="自我介绍 / 训练经历">
          <textarea className="personal-introduction-input" rows={4} maxLength={500} value={draft.experience}
            disabled={saving} onChange={event => change('experience', event.target.value)}/>
        </Field>
        <Field label="比赛需求">
          <input className="offline-profile-input" maxLength={500} value={draft.competition} disabled={saving}
            onChange={event => change('competition', event.target.value)}/>
        </Field>
        {error && <p className="avatar-error" role="alert">{error}</p>}
        <Button kind="primary" type="submit" className="wide" disabled={saving || !guard.dirty}>
          {saving ? '正在保存…' : '保存资料'}
        </Button>
      </form>
    </Panel>
  </div>;
}

type BackupPreview = {incoming: Data; revision: number; plan: BackupMergePlan};

export function OfflineDataManagement({onBack}: {onBack: () => void}) {
  const {data, update, ask, hasPendingSave} = useApp();
  const backupField = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const [outgoing, setOutgoing] = useState('');
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [result, setResult] = useState<BackupMergeReport | null>(null);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const additionCount = preview
    ? Object.values(preview.plan.incomingCounts).reduce((sum, count) => sum + count, 0)
      - preview.plan.identical.length - preview.plan.conflicts.length
    : 0;

  function generate() {
    setOutgoing(JSON.stringify({...data, connection: initialData().connection}, null, 2));
    setCopyStatus('');
  }

  async function copyBackup() {
    backupField.current?.focus();
    backupField.current?.select();
    try {
      await navigator.clipboard.writeText(outgoing);
      setCopyStatus('已复制备份文本，请另行保存。');
    } catch {
      setCopyStatus('请选择文本框内的内容并使用系统复制。');
    }
  }

  function showPreview() {
    setError('');
    setResult(null);
    setPreview(null);
    try {
      const incoming = inspectBackup(raw);
      setPreview({incoming, revision: data.revision, plan: planBackupMerge(data, incoming)});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '这份备份无法预览。');
    }
  }

  async function apply() {
    if (!preview || inFlight.current || additionCount < 1) return;
    setError('');
    if (preview.revision !== data.revision || hasPendingSave()) {
      setPreview(null);
      setError('本机资料已变化或仍待保存，请重新预览备份。');
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      if (await ask('确认导入这些资料？',
        '合并会添加预览中可导入的项目，并保留本机已有资料。',
        ['返回预览', '确认导入']) !== 1) return;
      let report: BackupMergeReport | undefined;
      const saved = await update(current => {
        if (current.revision !== preview.revision) throw new Error('本机资料已变化，请重新预览。');
        const merged = mergeBackup(current, preview.incoming, 'keep-existing');
        Object.assign(current, merged.data);
        report = merged.report;
      });
      if (saved && report) {
        setResult(report);
        setPreview(null);
        setRaw('');
      } else {
        setPreview(null);
        setError('备份尚未合并，请核对本机保存状态后重新预览。');
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return <div className="offline-profile">
    <Back title="数据管理" onBack={onBack}/>
    <Panel title="本机备份">
      <p>当前有 {data.sessions.length} 场训练、{data.plans.length} 份计划和 {data.equipment.length} 套器材。</p>
      <p className="caption">复制备份文本后请存到自己的设备。备份不含登录凭据、连接设置、照片或视频文件。</p>
      <Button kind="primary" onClick={generate}>生成备份文本</Button>
      {outgoing && <>
        <Field label="备份文本">
          <textarea ref={backupField} className="offline-backup-text" readOnly rows={5} value={outgoing}/>
        </Field>
        <Button onClick={() => void copyBackup()}>复制备份文本</Button>
        {copyStatus && <p className="caption" role="status">{copyStatus}</p>}
      </>}
    </Panel>
    <Panel title="恢复 / 合并">
      <p>粘贴完整的 JSON 备份文本。核对预览后再确认导入。</p>
      <Field label="粘贴备份文本">
        <textarea className="offline-backup-text" rows={5} maxLength={24 * 1024 * 1024} spellCheck={false}
          value={raw} disabled={saving} onChange={event => {
            setRaw(event.target.value);
            setPreview(null);
            setResult(null);
            setError('');
          }}/>
      </Field>
      <Button disabled={saving || !raw.trim()} onClick={showPreview}>预览备份</Button>
      {error && <p role="alert" className="avatar-error">{error}</p>}
    </Panel>
    {preview && <Panel title="恢复 / 合并预览">
      <p>备份中有 {preview.incoming.sessions.length} 场训练和 {preview.incoming.plans.length} 份计划。</p>
      <p>可导入 {additionCount} 项 · 已存在 {preview.plan.identical.length} 项 · 保留本机冲突项 {preview.plan.conflicts.length} 项</p>
      {preview.plan.warnings.map(warning => <p key={warning} className="caption">{warning}</p>)}
      {additionCount < 1 && <p role="status">这份备份没有需要合并的新项目。</p>}
      <Button kind="primary" className="wide" disabled={saving || additionCount < 1} onClick={() => void apply()}>
        {saving ? '正在核对…' : '确认恢复 / 合并'}
      </Button>
    </Panel>}
    {result && <Panel title="本机合并完成">
      <p role="status">新增 {Object.values(result.added).reduce((sum, count) => sum + count, 0)} 项，保留或跳过 {result.skipped.length} 项。</p>
      {result.warnings.map((warning, index) => <p key={index} className="caption">{warning}</p>)}
    </Panel>}
    <Panel title="保存位置">
      <p>训练保存在本应用的本机存储。清除应用数据或卸载之前，请先复制并妥善保管备份。</p>
    </Panel>
  </div>;
}

const features = {
  account: ['账号中心', '离线开发版使用本机资料，登录、账号管理和云保存需正式服务。可在数据管理保存本机备份。'],
  team: ['我的团队', '团队训练、教练安排和成绩共享需联网服务。可以使用本机计划安排个人训练。'],
  rewards: ['邀请与特别伙伴', '邀请与权益依赖正式服务。个人资料中可选择本机预设头像。'],
  announcements: ['公告与版本说明', '离线开发版暂未接入公告和应用内更新。重新构建开发包可更新此版本。'],
  support: ['赞赏支持', '离线开发版未接入支付或赞赏服务。'],
  feedback: ['反馈', '离线开发版未接入反馈服务。'],
  photo: ['照片识别', '离线开发版未随包提供识别模型。可以用数字记分或点靶录入。'],
} as const;

export function OfflineFeature({feature, onBack}: {feature: keyof typeof features; onBack: () => void}) {
  const [title, description] = features[feature];
  const {open} = useApp();
  return <div className="offline-profile">
    <Back title={title} onBack={onBack}/>
    <Panel title="离线开发版">
      <p>{description}</p>
      {feature === 'account' && <Button onClick={() => open('data')}>打开数据管理</Button>}
      {feature === 'team' && <Button onClick={() => open('plans')}>查看本机计划</Button>}
      {feature === 'rewards' && <Button onClick={() => open('personal')}>编辑个人资料</Button>}
    </Panel>
  </div>;
}

export function OfflineAbout({onBack}: {onBack: () => void}) {
  return <div className="offline-profile">
    <Back title="关于弓行记" onBack={onBack}/>
    <Panel title="弓行记 · 离线开发版">
      <p>用于本机个人射箭训练。训练记录与正式版分别保存在各自的应用中。</p>
    </Panel>
    <Panel title="当前设备能力">
      <p>可使用训练计划、数字与点靶记分、复盘、目标、器材、自建靶面和本机备份。</p>
      <p>账号、云保存、团队、邀请、在线资讯和应用内更新需要正式服务。</p>
      <p>此包未提供照片识别模型和视频动作观察。训练时可继续手动记分。</p>
    </Panel>
  </div>;
}

export function OfflineUserGuide({onBack}: {onBack: () => void}) {
  const {open} = useApp();
  return <div className="offline-profile">
    <Back title="使用指南" onBack={onBack}/>
    <Panel>
      <div className="user-guide">
        <details className="review-data-details" open><summary>1. 开始训练</summary>
          <p>在「训练」新开训练，或从本机计划开始。选好弓种、靶面、距离和每组箭数。</p>
          <Button onClick={() => open('training')}>去训练</Button>
        </details>
        <details className="review-data-details"><summary>2. 逐箭记分</summary>
          <p>用数字或点靶记分。X 和 10 都计 10 分，X 单独统计。M 计 0 分且算一箭。</p>
          <Button onClick={() => open('score')}>去记分</Button>
        </details>
        <details className="review-data-details"><summary>3. 完成并复盘</summary>
          <p>完成训练后，可在「复盘」查看历史、逐箭成绩和统计。</p>
          <Button onClick={() => open('history')}>去复盘</Button>
        </details>
        <details className="review-data-details"><summary>4. 备份与恢复</summary>
          <p>在「数据管理」复制备份文本。恢复时先粘贴并预览，确认后合并新记录。</p>
          <Button onClick={() => open('data')}>打开数据管理</Button>
        </details>
      </div>
    </Panel>
  </div>;
}
