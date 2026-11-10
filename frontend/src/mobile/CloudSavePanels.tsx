import './records-cloud.css';
import React,{useCallback,useState} from 'react';
import {AutomaticCloudSavePanel} from './AutomaticCloudSavePanel';
import {PrivateMediaPanel} from './PrivateMediaPanel';
import {ProtectedArchivePanel} from './ProtectedArchivePanel';
import {MediaArchivePanel} from './MediaArchivePanel';
import {cloudSync} from './cloud-sync';
import type {MediaObject} from './private-media-client';
import type {MediaArchiveRequest,MediaArchiveExport} from './media-archive-client';
import {automaticRecordsSaveReady,privateMediaSaveReady,protectedArchiveReady} from './release-mode';

/** The new opt-in capabilities have independent gates from the manual-backup panel. */
export function CloudSavePanels({conflictsOnly=false}:{conflictsOnly?:boolean}={}){
  const identity=cloudSync.getStatus().authVerified&&cloudSync.getStatus().phoneVerified?cloudSync.manualBackupIdentity():null,identityKey=JSON.stringify(identity);
  const [catalog,setCatalog]=useState<{identityKey:string;objects:MediaObject[]}>({identityKey:'null',objects:[]});
  const onCatalog=useCallback((objects:MediaObject[])=>{const current=cloudSync.getStatus().authVerified&&cloudSync.getStatus().phoneVerified?cloudSync.manualBackupIdentity():null;setCatalog({identityKey:JSON.stringify(current),objects:current&&objects.every(o=>o.ownerId===current.owner)?objects:[]});},[]);
  return <>
    {automaticRecordsSaveReady&&<AutomaticCloudSavePanel conflictsOnly={conflictsOnly}/>}
    {!conflictsOnly&&privateMediaSaveReady&&<PrivateMediaPanel onCatalog={onCatalog}/>}
    {!conflictsOnly&&protectedArchiveReady&&<ProtectedArchivePanel/>}
    {!conflictsOnly&&protectedArchiveReady&&<MediaArchivePanel objects={catalog.identityKey===identityKey?catalog.objects:[]} request={archiveRequest} exportArchive={cloudSync.mediaArchiveExportAvailable()?archiveExport:undefined}/>}
  </>;
}
const archiveRequest:MediaArchiveRequest=(...args)=>cloudSync.mediaArchiveRequest(...args);
const archiveExport:MediaArchiveExport=(...args)=>cloudSync.exportMediaArchive(...args);
