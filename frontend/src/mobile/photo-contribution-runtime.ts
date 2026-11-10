import {cloudSync} from './cloud-sync';
import {PhotoContributionController} from './photo-contribution-controller';
import {IndexedContributionStore} from './photo-contribution-store';
export const photoContributions=new PhotoContributionController({
 captureIdentity:()=>cloudSync.photoContributionCaptureIdentity(),identity:()=>cloudSync.photoContributionIdentity(),localIdentity:()=>cloudSync.photoContributionLocalIdentity(),available:()=>cloudSync.photoContributionAvailable(),
 policy:signal=>cloudSync.photoContributionPolicy(signal),
 request:(identity,method,path,signal,body,requestId)=>cloudSync.photoContributionRequest(identity,method,path,signal,body,requestId),
},new IndexedContributionStore());

// One drain per new durable state/online event. Unknown steps are never resent.
if(typeof window!=='undefined'){let scheduled=false;const pump=()=>{if(scheduled||!photoContributions.hasDrainRequest()||photoContributions.getSnapshot().busy||cloudSync.getStatus().busy||navigator.onLine===false)return;scheduled=true;setTimeout(()=>{scheduled=false;if(!photoContributions.getSnapshot().busy&&!cloudSync.getStatus().busy&&navigator.onLine!==false)void photoContributions.drainScheduled();},200);};cloudSync.subscribe(()=>{photoContributions.identityChanged();pump();});photoContributions.subscribe(pump);photoContributions.networkChanged();window.addEventListener('offline',photoContributions.networkChanged);window.addEventListener('online',()=>{photoContributions.networkChanged();void photoContributions.refresh().then(pump);});}
