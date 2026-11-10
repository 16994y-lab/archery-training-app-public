import React,{useSyncExternalStore} from 'react';
import {cloudSync} from './cloud-sync';
import {AccountChannelPanel} from './AccountChannelPanel';
import {OptionalInvitationPanel} from './OptionalInvitationPanel';
import {emailChangeReady,phoneChangeReady,invitationsReady} from './release-mode';

/** Only Root owns the original session and credential transport closure. */
export function AccountChannelAccess(){
  const status=useSyncExternalStore(cloudSync.subscribe,cloudSync.getStatus,cloudSync.getStatus);
  const actor=status.authVerified?cloudSync.channelActor():null;
  if(!actor)return null;
  return <div key={actor.owner+':'+actor.sessionEpoch}>
    <AccountChannelPanel actor={actor} transport={cloudSync.accountChannelTransport} emailEnabled={emailChangeReady&&status.phoneVerified===true} phoneEnabled={phoneChangeReady&&status.phoneVerified===true}/>
    {invitationsReady?<OptionalInvitationPanel actor={actor} transport={cloudSync.invitationTransport} enabled={status.phoneVerified===true}/>:<details className="legacy-invite-status"><summary>旧版邀请记录</summary><OptionalInvitationPanel actor={actor} transport={cloudSync.invitationTransport} enabled={false}/></details>}
  </div>;
}
