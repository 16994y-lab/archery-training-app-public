import type {PhotoStage} from './diagnostics';

const progressMessages:Partial<Record<PhotoStage,string>>={
 WASM_CHECK:'正在检查本机识别环境…',
 RUNTIME_LOAD:'正在加载本机识别组件…',
 MODEL_FETCH:'正在下载识别模型，首次加载可能较慢…',
 MODEL_VERIFY:'正在校验识别模型…',
 MODEL_VERIFY_FAILED:'模型校验暂不可用，本次继续本机识别…',
 SESSION_CREATE:'正在加载运行组件并初始化识别模型…',
 INFERENCE_RUN:'正在寻找接触点…',
};
export function photoDownloadProgressMessage(receivedBytes:number):string{return '正在下载识别模型，已接收 '+(receivedBytes/1_000_000).toFixed(1)+' MB…';}
export function photoProgressMessage(stage:PhotoStage):string|undefined{return progressMessages[stage];}

const failureMessages={
 PHOTO_INPUT:'照片输入无法用于识别，请重新选择或返回手动记分。',
 PHOTO_WASM:'本机识别环境未通过检查，请更新系统 WebView 或返回手动记分。',
 PHOTO_RUNTIME:'本机识别组件加载失败，请重新打开应用或返回手动记分。',
 PHOTO_MODEL_STALLED:'识别模型下载已连续30秒没有进展，已停止。请检查网络后重试或返回手动记分。',
 PHOTO_MODEL_FETCH:'识别模型下载未完成，请检查网络后重新选择照片，或返回手动记分。',
 PHOTO_MODEL:'本机识别模型初始化未完成，请返回手动记分。',
 PHOTO_INFERENCE:'本机识别计算未完成，请返回手动记分。',
 PHOTO_OUTPUT:'识别结果未通过检查，未导入候选。',
} as const;
export type PhotoFailureCode=keyof typeof failureMessages;
export function photoFailureMessage(code:unknown):string{
 return typeof code==='string'&&Object.prototype.hasOwnProperty.call(failureMessages,code)
  ?failureMessages[code as PhotoFailureCode]:'本机识别未能完成，请返回手动记分。';
}
