type OfflineFileMime = 'image/png' | 'text/csv' | 'application/json';
type OfflineFileStatus = 'saved' | 'cancelled';

type OfflineFileBridge = {
  saveFile(id: string, name: string, mime: OfflineFileMime, content: string): string;
};

const eventName = 'gongxingji-offline-file-save';

function offlineFileBridge() {
  return (window as Window & { GongxingjiOfflineFiles?: OfflineFileBridge }).GongxingjiOfflineFiles;
}

export function isOfflineFileHost() {
  return window.location.origin === 'https://offline.gongxingji.invalid';
}

export function hasOfflineFileSaver() {
  return isOfflineFileHost() && typeof offlineFileBridge()?.saveFile === 'function';
}

export async function saveOfflineFile(name: string, content: string, mime: OfflineFileMime): Promise<OfflineFileStatus> {
  const bridge = offlineFileBridge();
  if (!hasOfflineFileSaver() || !bridge) throw new Error('此设备当前无法保存文件');
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  return new Promise((resolve, reject) => {
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; status?: string }>).detail;
      if (detail?.id !== id) return;
      window.removeEventListener(eventName, onResult);
      if (detail.status === 'saved' || detail.status === 'cancelled') resolve(detail.status);
      else reject(new Error('文件保存失败，请重试'));
    };
    window.addEventListener(eventName, onResult);
    try {
      const state = bridge.saveFile(id, name, mime, content);
      if (state === 'accepted') return;
      throw new Error(state === 'busy' ? '已有一个文件正在保存' : '文件格式或大小超出保存范围');
    } catch (error) {
      window.removeEventListener(eventName, onResult);
      reject(error);
    }
  });
}
