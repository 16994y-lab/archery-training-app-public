import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../package.json',import.meta.url)),{build}=require('esbuild'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const frontend=fileURLToPath(new URL('..',import.meta.url));
const built=await build({stdin:{contents:"export * from './src/mobile/avatar-local';export * from './src/mobile/profile-local';export * from './src/mobile/intro-preference';export * from './src/mobile/photo-help';export {AccountAccess} from './src/mobile/AccountAccess';export {IntroScreens} from './src/mobile/IntroScreens';export {cloudSync,cloudDocument} from './src/mobile/cloud-sync';export {AppCtx} from './src/mobile/ui';export {initialData} from './src/mobile/domain';",resolveDir:frontend,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',external:['react','react-dom'],loader:{'.css':'empty'},define:{'import.meta.url':JSON.stringify('file:///synthetic-ui-candidate.mjs')}});
function fresh(){const module={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(module,module.exports,require);return module.exports;}
const C=fresh();
function storage(){const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};}
const denied={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){throw new Error('denied');}};
const ctx={data:C.initialData(),update:async()=>true,open(){},tell(){},ask:async()=>0,retryPendingSave:async()=>true,hasPendingSave:()=>false};
function render(component){return renderToStaticMarkup(React.createElement(C.AppCtx.Provider,{value:ctx},component));}

test('account default nickname is stable across isolated clients without local storage or random state',async()=>{
 const a=fresh(),b=fresh(),owner='synthetic-nickname-a';
 const name=await a.defaultNickname(owner);
 assert.match(name,/^打弓人\d{4}$/);assert.equal(await b.defaultNickname(owner),name);
 assert.equal(await a.defaultNickname(owner),name);assert.ok(!name.includes(owner));
});
test('default nickname uses the frozen SHA256 v1 contract without authentication channel data',async()=>{
 const {createHash}=require('node:crypto'),owner='synthetic-contract-owner';
 const expected='打弓人'+String(createHash('sha256').update('gongxingji-account-default-name/v1:'+owner).digest().readUInt32BE(0)%10000).padStart(4,'0');
 assert.equal(await C.defaultNickname(owner),expected);await assert.rejects(C.defaultNickname(''),/确认/);
});
test('legacy local storage and random functions cannot change account default nickname',async()=>{
 const a=fresh(),b=fresh(),s=storage();s.setItem('gongxingji-public-nickname-v1:synthetic-denied','打弓人1234');
 const name=await a.defaultNickname('synthetic-denied',s,()=>1234);
 assert.equal(await b.defaultNickname('synthetic-denied',denied,()=>9876),name);
 assert.equal(s.getItem('gongxingji-public-nickname-v1:synthetic-denied'),'打弓人1234');
});
test('nickname edit accepts eight visible characters and rejects empty, controls, and excess length',()=>{
 assert.equal(C.validNickname('  原来的称呼  '),'原来的称呼');
 assert.equal(C.validNickname('字'.repeat(8)),'字'.repeat(8));
 assert.equal(C.validNickname('弓'.repeat(7)+'👩‍🦰'),'弓'.repeat(7)+'👩‍🦰');
 for(const name of ['  ','x\nname','字'.repeat(9)])assert.throws(()=>C.validNickname(name));
});
test('nickname edit rejects configured terms even with separators, mixed case or full-width text',()=>{
 for(const name of ['弓行记客服','弓行记·客服','ＦuＣＫ'])assert.throws(()=>C.validNickname(name),/违禁词/);
 assert.equal(C.validNickname('打弓人0007'),'打弓人0007');
});
test('explicit phone nickname uses only a verified masked suffix and retains leading zeros',()=>{
 assert.equal(C.nicknameFromVerifiedPhoneDisplay('13*****0007'),'打弓人0007');
 for(const value of [undefined,'','13800000007','13****0007','13*****0007x','***0007'])assert.equal(C.nicknameFromVerifiedPhoneDisplay(value),null);
});
test('ordinary login and old intro flag do not create registration pending state',()=>{const c=fresh(),s=storage();s.setItem('gongxingji-intro-v1','seen');assert.equal(c.hasPendingRegistrationIntro('old-owner',s),false);assert.equal(c.hasPendingRegistrationIntro(null,s),false);assert.equal(s.values.size,1);});
test('new registration pending is isolated to its owner and not completed on opening',()=>{const c=fresh(),s=storage();c.markRegistrationIntroPending('new-a',s);assert.equal(c.hasPendingRegistrationIntro('new-a',s),true);assert.equal(c.hasPendingRegistrationIntro('new-b',s),false);assert.equal([...s.values.values()][0],'password');});
test('completed/skipped registration presentation stays completed after fresh module load',()=>{const c=fresh(),s=storage();c.markRegistrationIntroPending('new-done',s);c.finishRegistrationIntro('new-done',s);assert.equal(fresh().hasPendingRegistrationIntro('new-done',s),false);c.markRegistrationIntroPending('new-done',s);assert.equal(c.hasPendingRegistrationIntro('new-done',s),false);});
test('storage denial never blocks registration presentation skip or ordinary access',()=>{const c=fresh();c.markRegistrationIntroPending('new-denied',denied);assert.equal(c.hasPendingRegistrationIntro('new-denied',denied),true);c.finishRegistrationIntro('new-denied',denied);assert.equal(c.hasPendingRegistrationIntro('new-denied',denied),false);});
test('unknown owner cannot mark registration completion',()=>{assert.throws(()=>C.markRegistrationIntroPending('',storage()),/未确认/);});
test('photo help opening is read-only; explicit skip persists; revisit does not reset it',()=>{const c=fresh(),s=storage();assert.equal(c.hasSeenPhotoHelp(s),false);assert.equal(s.values.size,0);c.finishPhotoHelp(s);assert.equal(s.getItem(c.PHOTO_HELP_KEY),'done');assert.equal(fresh().hasSeenPhotoHelp(s),true);});
test('photo tutorial storage denial permits dismissal in this execution',()=>{const c=fresh();assert.equal(c.hasSeenPhotoHelp(denied),false);assert.doesNotThrow(()=>c.finishPhotoHelp(denied));assert.equal(c.hasSeenPhotoHelp(denied),true);});
test('twelve avatar IDs and paths match the independent asset contract',()=>{assert.equal(C.FURRY_AVATARS.length,12);assert.equal(new Set(C.FURRY_AVATARS.map(x=>x[0])).size,12);for(const [id] of C.FURRY_AVATARS)assert.ok(C.furryImage(id).endsWith(`/public/ui/avatars/${id}.png`));});
test('unselected, unsupported, empty and oversize input images fail before persistence',()=>{for(const file of [{size:1,type:'image/svg+xml'},{size:0,type:'image/png'},{size:C.AVATAR_INPUT_LIMIT+1,type:'image/jpeg'}])assert.throws(()=>C.validateAvatarInput(file));assert.doesNotThrow(()=>C.validateAvatarInput({size:8192,type:'image/webp'}));});
test('crop rectangle remains within image at zoom and pan limits',()=>{for(const rotation of [0,90,180,270])for(const zoom of [1,2,4,99])for(const x of [-3,-1,0,1,3]){const rect=C.avatarCropRect(800,600,{rotation,zoom,x,y:-x});assert.ok(rect.left>=0&&rect.top>=0);assert.ok(rect.left+rect.side<=rect.width+1e-9);assert.ok(rect.top+rect.side<=rect.height+1e-9);}});
test('ninety-degree rotation swaps dimensions without fabricating image pixels',()=>{const rect=C.avatarCropRect(800,600,{rotation:90,zoom:1,x:0,y:0});assert.deepEqual(rect,{width:600,height:800,side:600,left:0,top:100});});
test('invalid pixel dimensions and non-finite crop values are rejected',()=>{for(const [w,h] of [[0,100],[100,NaN],[10000,10000]])assert.throws(()=>C.avatarCropRect(w,h,C.initialAvatarCrop));assert.throws(()=>C.avatarCropRect(800,600,{...C.initialAvatarCrop,x:Infinity}));});
test('successful avatar write is isolated per owner and contains only local blob/reference',async()=>{const rows=new Map(),port={read:async owner=>rows.get(owner)??null,write:async(owner,value)=>{rows.set(owner,value);}};await C.saveLocalAvatar(port,'avatar-a',{kind:'preset',id:'furry-otter'});assert.equal((await port.read('avatar-a')).id,'furry-otter');assert.equal(await port.read('avatar-b'),null);});
test('quota failure retains the previous avatar and never adopts a failed write',async()=>{const previous={kind:'preset',id:'furry-bear'};let stored=previous;const port={read:async()=>stored,write:async()=>{throw Error('quota');}};await assert.rejects(()=>C.saveLocalAvatar(port,'quota-owner',{kind:'photo',blob:new Blob(['synthetic'],{type:'image/jpeg'})}),/quota/);assert.equal(await port.read('quota-owner'),previous);});
test('unknown and changed owner reject avatar write before the storage port is called',async()=>{let calls=0;const port={read:async()=>null,write:async()=>{calls++;}};await assert.rejects(()=>C.saveLocalAvatar(port,'',{kind:'preset',id:'furry-bear'}));await assert.rejects(()=>C.saveLocalAvatar(port,'avatar-a',{kind:'preset',id:'furry-bear'},()=>null),/变化/);assert.equal(calls,0);});
test('late write from owner A cannot be adopted into owner B',async()=>{let owner='avatar-a';const port={read:async()=>null,write:async()=>{owner='avatar-b';}};assert.equal(await C.saveLocalAvatar(port,'avatar-a',{kind:'preset',id:'furry-bear'},()=>owner),'original-owner');});
test('corrupt and excessive output avatar records are rejected',()=>{assert.throws(()=>C.validateLocalAvatar({kind:'preset',id:'unknown'}));assert.throws(()=>C.validateLocalAvatar({kind:'photo',blob:new Blob(['x'],{type:'image/png'})}));assert.throws(()=>C.validateLocalAvatar({kind:'photo',blob:new Blob([new Uint8Array(C.AVATAR_OUTPUT_LIMIT+1)],{type:'image/jpeg'})}));});
test('local photo bytes do not change training backup or cloud projection',async()=>{const data=C.initialData(),before=JSON.stringify(data),cloudBefore=JSON.stringify(C.cloudDocument(data));let image=null;await C.saveLocalAvatar({read:async()=>image,write:async(_owner,value)=>{image=value;}},'avatar-a',{kind:'photo',blob:new Blob(['synthetic-image-bytes'],{type:'image/jpeg'})});assert.equal(JSON.stringify(data),before);assert.equal(JSON.stringify(C.cloudDocument(data)),cloudBefore);assert.ok(image);});
test('default account SSR exposes the phone code form, separate +86 prefix, password and email routes',t=>{
 t.mock.method(C.cloudSync,'getStatus',()=>({owner:null,email:null,phoneVerified:false,authVerified:false,busy:false}));
 t.mock.method(C.cloudSync,'enrollmentService',()=> 'synthetic-service');
 t.mock.method(C.cloudSync,'otpRetrySeconds',()=>0);
 t.mock.method(C.cloudSync,'otpSendPending',()=>false);
 const html=render(React.createElement(C.AccountAccess,{startup:true}));
 assert.equal((html.match(/<form\b/g)??[]).length,1);
 assert.match(html,/account-country[^>]*>\+86</);
 assert.match(html,/aria-label="中国大陆 \+86 手机号"/);
 assert.match(html,/aria-label="6 位短信验证码"/);
 assert.match(html,/autoComplete="one-time-code"/i);
 assert.match(html,/>获取验证码</);
 assert.match(html,/>使用密码登录</);
 assert.match(html,/>邮箱登录</);
 assert.doesNotMatch(html,/account-tabs-three/);
});
test('registered intro hides existing-account action and exposes start-training label',()=>{const html=render(React.createElement(C.IntroScreens,{context:'registered',onDone(){},onSkip(){},onExistingAccount(){}}));assert.doesNotMatch(html,/已有账号，直接登录/);assert.match(html,/>跳过<\/button>/);assert.equal(C.hasPendingRegistrationIntro('ordinary-no-event',storage()),false);});

test('skip/save password persists intro stage so ordinary relaunch never repeats password offer',()=>{const c=fresh(),s=storage();c.markRegistrationIntroPending('stage-owner',s);assert.equal(c.registrationIntroStage('stage-owner',s),'password');c.advanceRegistrationIntro('stage-owner',s);assert.equal(fresh().registrationIntroStage('stage-owner',s),'intro');c.markRegistrationIntroPending('stage-owner',s);assert.equal(c.registrationIntroStage('stage-owner',s),'intro');});
test('advancing unknown or completed presentation cannot create a registration event',()=>{const c=fresh(),s=storage();c.advanceRegistrationIntro('no-event',s);assert.equal(c.registrationIntroStage('no-event',s),null);c.finishRegistrationIntro('done-stage',s);c.advanceRegistrationIntro('done-stage',s);assert.equal(c.registrationIntroStage('done-stage',s),null);});

test('canceled avatar save never starts a write or overwrites previous value',async()=>{const previous={kind:'preset',id:'furry-bear'},abort=new AbortController();abort.abort();let value=previous,calls=0;const port={read:async()=>value,write:async(_owner,next)=>{calls++;value=next;}};await assert.rejects(()=>C.saveLocalAvatar(port,'cancel-owner',{kind:'preset',id:'furry-otter'},()=> 'cancel-owner',abort.signal));assert.equal(calls,0);assert.equal(value,previous);});
