import {builtTargets,type Target} from './domain';
import {photoTargetProfile} from '../photo-assist/target';

export type PhotoTargetLocationIssue='invalid-image'|'no-reliable-target'|'ambiguous-target';
export type PhotoTargetNoticeState={
 kind:'supported-selection'|'unsupported-custom'|'unsupported-rules'|'invalid-face'|'location-unknown'|'ambiguous-photo';
 title:string;
 message:string;
 selectedLabel:string;
 alert:boolean;
 supported:boolean;
 photoTargetIdentity:'unknown';
};

export function photoSupportedTargets():readonly Target[]{
 return builtTargets.filter(target=>photoTargetProfile(target,1)!==null);
}

/** Reports existing rule support/location evidence. It never classifies a photographed target. */
export function photoTargetNotice(target:Target,face:number,issue?:PhotoTargetLocationIssue):PhotoTargetNoticeState{
 const validFace=Number.isInteger(face)&&face>=1&&face<=target.face_count;
 const supported=photoTargetProfile(target,face)!==null;
 const selectedLabel=`${target.name}${target.face_count>1?` · ${validFace?`${face} 号靶位`:'靶位待核对'}`:''}`;
 const base={selectedLabel,supported,photoTargetIdentity:'unknown' as const};
 if(!validFace)return {...base,kind:'invalid-face',title:'当前靶位需要核对',alert:true,
  message:'当前靶位超出已选靶型的范围。请返回记分，重新选择靶位后再使用照片录入。'};
 if(!supported)return {...base,kind:target.custom?'unsupported-custom':'unsupported-rules',title:'当前选择暂不支持照片录入',alert:true,
  message:target.custom?'自建靶型尚未接入照片录入，可返回使用数字或点靶记分。':'当前规则与受支持的内置靶型不同，可返回使用数字或点靶记分。'};
 if(issue==='ambiguous-target')return {...base,kind:'ambiguous-photo',title:'照片里的主靶不唯一',alert:true,
  message:'照片中无法确定唯一主靶；这不说明靶型选错。请核对当前靶位，删除其他靶位的候选，并逐箭确认环值。'};
 if(issue)return {...base,kind:'location-unknown',title:'照片靶面尚未可靠定位',alert:true,
  message:issue==='invalid-image'?'照片暂时无法用于靶面定位；无法据此判断靶型。可换图，或按照片人工核对。':'未获得可靠的靶面位置；无法据此判断靶型是否一致。请对照照片核对选择，并逐箭确认环值。'};
 return {...base,kind:'supported-selection',title:'核对当前靶型',alert:false,
  message:target.face_count>1?'照片环值按当前选择的靶型和靶位计算。请确认照片对应这个靶位，并核对反曲／复合内十环规则。':'照片环值按当前选择的靶型计算。请核对照片的环数、X 和内十环规则。'};
}
