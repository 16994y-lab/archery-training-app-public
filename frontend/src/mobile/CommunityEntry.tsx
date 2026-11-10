import React from 'react';
import {Panel} from './ui';

/** Production community stays closed until the shared service and device gates pass. */
export function CommunityEntry(){
 return <><div className="page-title"><span className="eyebrow">GONGXINGJI · 社区</span><h1>与同好交流</h1><p>文字社区正在完成账号、服务与安全验收。</p></div><Panel title="开放进度"><p>目前尚不能跨用户发布或查看帖子。完成真实账号、多人读回和设备验收后，这里才会开放。</p><p className="caption">训练和记分可以照常使用；这里不会上传你的训练记录、照片或草稿。</p></Panel></>;
}
