import {DEFAULT_AVATARS_V2} from './avatar-catalog-v2';

// Presentation-only selection list. Keep the complete legacy catalog for reads.
const ordinaryIds=['furry-red-panda','furry-rabbit','furry-cat','furry-shiba','furry-otter','furry-hedgehog'] as const;
export type OrdinaryAvatarId=typeof ordinaryIds[number];
export const ORDINARY_AVATAR_CHOICES=Object.freeze(ordinaryIds.map(id=>{
 const item=DEFAULT_AVATARS_V2.find(value=>value.id===id);
 if(!item)throw new Error('普通头像目录不完整');
 return item;
}));
export const isOrdinaryAvatarId=(id:unknown):id is OrdinaryAvatarId=>ordinaryIds.some(value=>value===id);

// Discovery metadata only: no image URL, selectable ID, grant, or paid flag.
export const HIDDEN_AVATAR_DISCOVERY=Object.freeze([
 Object.freeze({key:'sponsor',name:'星冠小弓',method:'真实赞赏资格',description:'真实赞赏由管理员核对到账与账号归属后获得；点击收款码或提交待核申请不会自动解锁。退款保留，误认来源另行纠错。',destination:'support',action:'了解赞赏支持'}),
 Object.freeze({key:'community',name:'披甲挽弓',method:'真实入群资格',description:'联系管理员核对领取授权后，在邀请与特别伙伴中输入为本人签发的12小时领取码。复制群号、点击入群不授予资格。',destination:'rewards',action:'输入本人领取码'}),
 Object.freeze({key:'invite',name:'结伴开弓',method:'邀请成功资格',description:'分享自己的稳定邀请码。新用户在首次注册完成前选填，经原验证及可信归因确认后，双方获得伙伴。已有账号不能补填计奖。',destination:'rewards',action:'查看我的邀请码'}),
] as const);
export type HiddenAvatarDiscovery=typeof HIDDEN_AVATAR_DISCOVERY[number];
