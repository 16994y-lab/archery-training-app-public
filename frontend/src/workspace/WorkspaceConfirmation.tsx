import React, {useId,useLayoutEffect,useRef} from 'react';

export function WorkspaceConfirmation({title,onCancel,children}:{
  title:string;
  onCancel:()=>void;
  children:React.ReactNode;
}) {
  const ref=useRef<HTMLDialogElement>(null);
  const titleId=useId();

  useLayoutEffect(()=>{
    const dialog=ref.current;
    if(!dialog)return;
    const opener=document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[data-confirm-cancel]')?.focus();
    return ()=>{
      dialog.close();
      if(opener instanceof HTMLElement&&opener.isConnected)opener.focus({preventScroll:true});
    };
  },[]);

  return <dialog ref={ref} className="reward-confirm ws-confirmation" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onCancel();}}>
    <h2 id={titleId}>{title}</h2>
    {children}
  </dialog>;
}
