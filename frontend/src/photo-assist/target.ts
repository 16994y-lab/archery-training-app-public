import {builtTargets,type Target} from '../mobile/domain';

export type PhotoTargetProfile={
 id:string;
 radiusRatio:number;
 face:number;
 multiFace:boolean;
};

const contractKeys:(keyof Target)[]=['target_type','rules_version','scoring_mode','ring_rules','allowed_score_codes','plot','layout','face_count','sizeRatio'];

/**
 * The locator fits the outer edge of the blue scoring area.  On a full
 * ten-ring face that is the 5-ring boundary (60% of the scoring radius),
 * while cropped 5/6-ring faces use their full radius.  Imported IDs alone
 * are never accepted as proof that these geometry rules still match.
 */
export function photoTargetProfile(target:Target,face:number):PhotoTargetProfile|null{
 const standard=builtTargets.find(t=>t.id===target.id);
 if(!standard||target.custom||target.scoring_mode!=='RING_GEOMETRY'||!Number.isInteger(face)||face<1||face>target.face_count)return null;
 if(!contractKeys.every(key=>JSON.stringify(target[key])===JSON.stringify(standard[key])))return null;
 const rings=target.ring_rules??[],geometryRing=rings.find(r=>r.score_code==='5')??[...rings].reverse().find(r=>r.score_code!=='X');
 const radiusRatio=(geometryRing?.outer_radius_norm??0)*2;
 if(!Number.isFinite(radiusRatio)||radiusRatio<=0||radiusRatio>1)return null;
 return {id:target.id,radiusRatio,face,multiFace:target.face_count>1};
}

export function supportsPhotoTarget(target:Target,face:number):boolean{return photoTargetProfile(target,face)!==null;}
