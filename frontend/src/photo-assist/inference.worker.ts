import {decodeContact} from './decoder';
import {isPhotoStage,type PhotoStage} from './diagnostics';
import {contributionModelHash,fetchModelBytes,ModelDownloadTimeout} from './model-resource';
import type {PhotoFailureCode} from './messages';
const worker=self as unknown as {onmessage:((e:MessageEvent)=>void)|null;postMessage:(message:unknown,transfer?:Transferable[])=>void};
let started=false;
let phaseAck:{stage:PhotoStage;done:()=>void}|undefined;
// Let the main thread forward each marker before the next large allocation.
// Missing diagnostics never block inference indefinitely.
function reportStage(stage:PhotoStage):Promise<void>{return new Promise(resolve=>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 const done=()=>{clearTimeout(timer);if(phaseAck?.done===done)phaseAck=undefined;resolve();};
 phaseAck={stage,done};timer=setTimeout(done,500);try{worker.postMessage({type:'stage',stage});}catch{done();}
});}
// Fixed stage messages never expose runtime paths, memory contents or raw ORT errors.
const failures={
 input:'PHOTO_INPUT',wasm:'PHOTO_WASM',runtime:'PHOTO_RUNTIME',download:'PHOTO_MODEL_FETCH',
 model:'PHOTO_MODEL',inference:'PHOTO_INFERENCE',output:'PHOTO_OUTPUT',
} as const satisfies Record<string,PhotoFailureCode>;
worker.onmessage=async(e:MessageEvent)=>{
 if(e.data&&e.data.type==='stage-ack'){const pending=phaseAck;if(isPhotoStage(e.data.stage)&&pending&&pending.stage===e.data.stage)pending.done();return;}
 if(started)return;started=true;
 let session:any,input:any,outputs:any,modelInput:Uint8Array<ArrayBuffer>|undefined;
 let stage:keyof typeof failures='input';
 const release=async()=>{
  modelInput=undefined;
  const tensors=outputs;outputs=undefined;
  for(const value of Object.values(tensors||{})){try{await (value as any).dispose();}catch{}}
  const tensor=input;input=undefined;try{tensor?.dispose();}catch{}
  const active=session;session=undefined;try{await active?.release();}catch{}
 };
 try{
  const {rgb,width,height,assetBase,diagnostic,verifyContribution}=e.data;
  if(!(rgb instanceof Float32Array)||!Number.isInteger(width)||!Number.isInteger(height)||width<32||height<32||Math.max(width,height)>1024||rgb.length!==3*width*height)throw Error('照片输入尺寸无效');
  const base=new URL(assetBase);if(base.origin!==self.location.origin)throw Error('模型只能从本机应用资源加载');
  stage='wasm';await reportStage('WASM_CHECK');
  // Eight-byte empty module tests actual WASM permission before ORT/model allocation.
  if(typeof WebAssembly==='undefined')throw Error('wasm-unavailable');
  await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));
  await reportStage('WASM_READY');stage='runtime';await reportStage('RUNTIME_LOAD');
  const ort=await import(/* @vite-ignore */ new URL('ort.wasm.min.mjs',base).href);
  ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths=base.href;
  await reportStage('RUNTIME_READY');stage='download';
  await reportStage('MODEL_FETCH');
  modelInput=await fetchModelBytes(new URL('phase11-contact.onnx',base).href,receivedBytes=>worker.postMessage({type:'model-download',receivedBytes}));
  await reportStage('MODEL_FETCH_DONE');let verifiedModelSha256:string|null=null;
  if(verifyContribution===true){
   await reportStage('MODEL_VERIFY');verifiedModelSha256=await contributionModelHash(modelInput);
   await reportStage(verifiedModelSha256?'MODEL_VERIFY_DONE':'MODEL_VERIFY_FAILED');
  }
  stage='model';await reportStage('SESSION_CREATE');
  try{session=await ort.InferenceSession.create(modelInput,{executionProviders:['wasm'],graphOptimizationLevel:'all'});}finally{modelInput=undefined;}
  await reportStage('SESSION_READY');
  stage='inference';
  input=new ort.Tensor('float32',rgb,[1,3,height,width]);
  await reportStage('TENSOR_READY');await reportStage('INFERENCE_RUN');
  const t=performance.now();outputs=await session.run({rgb:input});const inference_ms=performance.now()-t;await reportStage('INFERENCE_DONE');stage='output';const logits=outputs.contact_logits;
  if(!logits||logits.dims.join(',')!==[1,1,height,width].join(','))throw Error('识别输出尺寸异常');
  const probability=new Float32Array(width*height);for(let i=0;i<probability.length;i++)probability[i]=1/(1+Math.exp(-logits.data[i]));
  const peaks=decodeContact(probability,width,height),message:any={type:'result',peaks,width,height,inference_ms,verifiedModelSha256};
  // Release ORT resources before the main thread can start optional PNG work.
  await reportStage('DECODE_DONE');await reportStage('RELEASE_START');await release();await reportStage('RELEASE_DONE');
  if(diagnostic){message.probability=probability;worker.postMessage(message,[probability.buffer]);}else worker.postMessage(message);
 }catch(error){await reportStage('RELEASE_START');await release();await reportStage('RELEASE_DONE');worker.postMessage({type:'error',code:stage==='download'&&error instanceof ModelDownloadTimeout?'PHOTO_MODEL_STALLED':failures[stage]});}
 finally{await release();}
};
