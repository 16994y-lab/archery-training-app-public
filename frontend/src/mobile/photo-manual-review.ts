import {inUnit,type Candidate} from '../photo-geometry';

/** Photo-space marks are references only: no geometry, inferred score or target position. */
export function manualPhotoSaveable(candidates:readonly Candidate[],scores:Readonly<Record<string,string>>,allowed:readonly string[]){
 return candidates.length>0&&candidates.length<=256&&new Set(candidates.map(c=>c.id)).size===candidates.length
  &&candidates.every(c=>Boolean(c.id)&&inUnit(c.point)&&Object.prototype.hasOwnProperty.call(scores,c.id)&&allowed.includes(scores[c.id]));
}

export const MANUAL_PHOTO_PREVIEW_EDGE=1024;
