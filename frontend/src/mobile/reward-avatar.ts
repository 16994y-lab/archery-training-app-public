import {RewardsClient,type RewardKey,type RewardMe,rewardKeys,sameIdentity} from './rewards-api';
import type {TeamIdentity} from './team-api';

// Recheck authoritative grants at selection time. Stored artwork is not a grant.
export async function authorizeRewardAvatar(client:RewardsClient,bound:TeamIdentity,key:RewardKey):Promise<RewardMe>{
 if(!rewardKeys.includes(key)||!sameIdentity(client.identity(),bound))throw new Error('账号已变化，原头像保持');
 let result:RewardMe;try{result=await client.readMe(bound);}catch{throw new Error('当前奖励资格未能联网核对，原头像保持');}
 if(!sameIdentity(client.identity(),bound)||!result.rewards.includes(key))throw new Error('这款头像当前不可新选择，原头像保持');
 return result;
}
