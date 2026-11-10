import React from 'react';

// One shared notice for registration and later account-flow work. Reading this
// component does not persist consent or grant Android/cloud/model permissions.
export const USAGE_NOTICE_VERSION='2026-10-12';
export function UsageNotice(){
 return <details className="usage-notice"><summary>注册与使用须知</summary><div>
  <p>训练资料优先保存在本机，登录不会自动上传或转移已有资料。卸载应用、清除数据或更换设备前，请先保存完整备份。</p>
  <p>照片识别只提供待你核对的候选，确认后才保存成绩；器材资料供记录和查询，请自行核对实际适用性。</p>
  <p>相机、照片等系统权限会在使用对应功能时单独请求，阅读或接受本告知不代表已授予 Android 权限。</p>
  <p>云端上传和模型训练用途分别征求同意，不因注册、登录或阅读本告知自动开启。具体操作会说明所选内容和影响范围。</p>
 </div></details>;
}
