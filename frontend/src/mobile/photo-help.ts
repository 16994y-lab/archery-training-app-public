/** Local tutorial preference is independent of photo/model truth and authentication. */
export const PHOTO_HELP_KEY='gongxingji-photo-help-v2';
export const PHOTO_HELP_TEXT='请正对主靶，让靶纸完整入镜，箭与靶面的接触处保持清晰。停稳后点击拍摄。候选须逐箭核对，错误可手动校正。';
export type HelpStorage=Pick<Storage,'getItem'|'setItem'>;
let dismissed=false;
export function photoHelpStorage(){try{return localStorage;}catch{return undefined;}}
export function hasSeenPhotoHelp(storage:HelpStorage|undefined=photoHelpStorage()){
 if(dismissed)return true;try{return storage?.getItem(PHOTO_HELP_KEY)==='done';}catch{return false;}
}
export function finishPhotoHelp(storage:HelpStorage|undefined=photoHelpStorage()){
 dismissed=true;try{storage?.setItem(PHOTO_HELP_KEY,'done');return storage?.getItem(PHOTO_HELP_KEY)==='done';}catch{return false;}
}
