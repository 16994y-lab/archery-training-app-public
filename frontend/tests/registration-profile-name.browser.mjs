// Isolated Chrome, real auth acceptance, local account manager and profile page.
// Data and HTTP replies are synthetic; no real account or SMS is used.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const req=createRequire(new URL('../package.json',import.meta.url));
const {build}=req('esbuild');
const {chromium}=process.env.GONGXINGJI_PLAYWRIGHT_MODULE
  ? (await import(pathToFileURL(process.env.GONGXINGJI_PLAYWRIGHT_MODULE))).default : req('playwright');
const frontend=fileURLToPath(new URL('..',import.meta.url));
const fixture=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {HashRouter} from 'react-router-dom';
import {initialData} from './src/mobile/domain';
import {AppCtx} from './src/mobile/ui';
import {ProfileHome} from './src/mobile/ProfilePages';
import {CloudApiClient,serviceKey} from './src/mobile/api';
import {cloudSync,CloudSync} from './src/mobile/cloud-sync';
import {defaultNickname} from './src/mobile/profile-local';
import {createEnrollmentStorage} from './src/mobile/email-enrollment-storage';
const owner='00000000-0000-4000-8000-000000000001';
const enrollment='00000000-0000-4000-8000-000000000002',attempt='00000000-0000-4000-8000-000000000003';
const phone='+8613800000007';
const cutover=Date.parse('2026-11-03T09:34:00Z');
const config={api:'https://api.test.invalid/api',auth:'https://auth.test.invalid',publicKey:'synthetic-key'};
const data=initialData();data.connection=config;
let sessionRaw=null,identityRaw=null,metaRaw=null,now=cutover,created,rerender=()=>{};
let verifiedPhone=phone,phoneConfirmed=true,requests=[];
const disk={readSession:async()=>sessionRaw,writeSession:async v=>{sessionRaw=v},readLocalIdentity:async()=>identityRaw,
  writeLocalIdentity:async v=>{identityRaw=v},readMeta:async()=>metaRaw,writeMeta:async v=>{metaRaw=v}};
const credentials={access_token:'synthetic-a',refresh_token:'synthetic-r',expires_in:3600};
const http=async(url,opts)=>{
  const p=new URL(url).pathname;requests.push(p);
  if(p.endsWith('/email-enrollment/status'))return Response.json({owner,enrollment,attempt,state:'complete',delivery:'accepted',
    nativeOutcome:'accepted',emailVerified:true,registrationComplete:true,canVerify:false,canResend:false,expiresIn:0,retryAfter:0});
  if(p.endsWith('/otp'))return Response.json({sent:true,deliveryStatus:'accepted'});
  if(p.endsWith('/verify')||p.endsWith('/token'))return Response.json(credentials);
  if(p.endsWith('/user'))return Response.json({id:owner,created_at:created,phone:verifiedPhone,email:'synthetic@example.invalid',
    phone_confirmed_at:phoneConfirmed?'2026-11-03T09:35:00Z':null});
  throw Error('Unexpected request');
};
const sync=new CloudSync(disk,(c,p)=>new CloudApiClient(c,p,http,true),true,()=>now);
cloudSync.getStatus=sync.getStatus;cloudSync.subscribe=sync.subscribe;
const update=async edit=>{edit(data);rerender();return true;};
const ctx={update,open:()=>{},tell:()=>{},ask:async()=>0,hasPendingSave:()=>false,retryPendingSave:async()=>true};
const root=createRoot(document.getElementById('root'));
function App(){const [,tick]=useState(0);rerender=()=>tick(i=>i+1);
 return <HashRouter><AppCtx.Provider value={{...ctx,data}}><ProfileHome/></AppCtx.Provider></HashRouter>;}
window.setup=async(scenario)=>{
  const old=scenario.startsWith('old');created=old?'2026-11-03T09:33:59.999Z':scenario==='unknown'?undefined:'2026-11-03T09:34:01Z';
  await sync.initialize({read:()=>data,update,localAccount:()=>scenario==='old-custom'?serviceKey(config)+'|'+owner:null});
  if(scenario==='email-binding'){
    phoneConfirmed=false;await sync.login('synthetic@example.invalid','synthetic-password');
    const drafts=createEnrollmentStorage();await drafts.read();
    await drafts.write({version:1,service:serviceKey(config),email:'synthetic@example.invalid',
      resume:'a'.repeat(43),enrollment,createdAt:created});
    phoneConfirmed=true;await sync.verifyPhoneBinding(phone,'123456');
  } else {
    if(scenario==='old-custom')data.profile.name='自己起的名字';
    await sync.sendOtp('phone',phone,true);
    now+=2000;await sync.verifyOtp('phone',phone,'123456');
  }
  const afterRegister=data.profile.name;
  root.render(<App/>);
  return {afterRegister,legacy:await defaultNickname(owner),containsFullPhone:sessionRaw.includes(phone.slice(-11)),
    hint:sync.getStatus().profileDefaultName};
};
window.nameResult=()=>data.profile.name;
window.revalidate=async()=>{verifiedPhone='+8613900009999';await sync.verifySession();return sync.getStatus().profileDefaultName;};
`;
const compiled=await build({stdin:{contents:fixture,resolveDir:frontend,loader:'tsx'},bundle:true,
  platform:'browser',format:'esm',outfile:'fixture.js',write:false,logLevel:'silent',loader:{'.css':'empty'},
  define:{'import.meta.env':JSON.stringify({VITE_EMAIL_ENROLLMENT_READY:'true'})}});
const browser=await chromium.launch({headless:true,...(process.env.GONGXINGJI_BROWSER_EXECUTABLE?{executablePath:process.env.GONGXINGJI_BROWSER_EXECUTABLE}:{}),
  args:['--disable-background-networking','--no-first-run']});
try{
  for(const scenario of (process.env.NAME_CHECK_SCENARIO?[process.env.NAME_CHECK_SCENARIO]:['fresh','old-blank','old-custom','unknown','email-binding'])){
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*', route=>{
      const u=new URL(route.request().url());
      if(u.origin==='https://profile.test.invalid'&&u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>'});
      if(u.origin==='https://profile.test.invalid'&&u.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:compiled.outputFiles[0].text});
      return route.abort();
    });
    try{
      await page.goto('https://profile.test.invalid/');
      const result=await page.evaluate(s=>window.setup(s),scenario);
      const expected=scenario==='old-blank'?result.legacy:scenario==='old-custom'?'自己起的名字':scenario==='unknown'?'':'打弓人0007';
      const editor=page.getByRole('button',{name:'编辑用户名'});
      await editor.waitFor();
      if(expected){await page.waitForFunction(n=>window.nameResult()===n,expected);assert.ok((await editor.innerText()).includes(expected));}
      else{assert.equal(result.hint,null);assert.equal(await page.evaluate(()=>window.nameResult()),'');}
      if(scenario==='fresh'){
        assert.equal(result.afterRegister,'打弓人0007');
        assert.equal(await page.evaluate(()=>window.revalidate()),'打弓人0007');
      }
      if(scenario==='email-binding')assert.equal(result.afterRegister,'打弓人0007');
      if(scenario==='old-custom'){
        await editor.click();
        await page.getByRole('button',{name:'使用手机号后四位',exact:true}).click();
        assert.equal(await page.getByLabel('用户名',{exact:true}).inputValue(),'打弓人0007');
        assert.equal(await page.evaluate(()=>window.nameResult()),'自己起的名字');
        await page.getByRole('button',{name:'取消',exact:true}).click();
        assert.equal(await page.evaluate(()=>window.nameResult()),'自己起的名字');
      }
      assert.equal(result.containsFullPhone,false);
      assert.deepEqual(errors,[]);console.log('PASS',scenario);
    }finally{await context.close();}
  }
  console.log('PASS: selected profile name checks; real external calls 0');
}finally{await browser.close();}
