import type {AcceptedAccountFacts} from './api';

/** Short-lived presentation context. It contains neither token nor account permission. */
export type PhoneRegistrationWindow={service:string;startedAt:number};
export type RegistrationIdentity={service:string;owner:string;generation:number};

/**
 * A register button alone does not prove a new user: OTP also signs existing users in.
 * Require the authenticated account to have actually been created during this request.
 * Clock uncertainty or missing server facts leaves the tutorial available for replay.
 */
export function isFreshPhoneRegistration(facts:AcceptedAccountFacts|null,identity:RegistrationIdentity,attempt:PhoneRegistrationWindow|null,completedAt:number):boolean{
  if(!facts||!attempt||facts.source!=='otp'||!facts.phoneVerified||facts.owner!==identity.owner||facts.generation!==identity.generation||attempt.service!==identity.service||!facts.createdAt)return false;
  const createdAt=Date.parse(facts.createdAt);
  if(![createdAt,attempt.startedAt,completedAt].every(Number.isFinite)||completedAt<attempt.startedAt||completedAt-attempt.startedAt>300000)return false;
  return createdAt>=attempt.startedAt&&createdAt<=completedAt;
}
