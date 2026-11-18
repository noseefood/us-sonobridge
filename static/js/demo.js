import {createEnvironment} from './environment.js?v=9';
import {createJointCurve,sweepPhase,sweepPosition} from './motion.js?v=1';
import {labelPalette,labelPoseMasks} from './label-legend.js?v=1';
import {cleanVisibilityContours} from './guidance.js?v=2';
let THREE, OrbitControls, GLTFLoader, RoomEnvironment, MeshoptDecoder;
const $ = id => document.getElementById(id);
const root = new URL('../demo/', import.meta.url);
const datasets={liver:{manifest:'liver/manifest-v4.json',imageRoot:'liver/',label:'Liver',posture:'supine'},kidney:{manifest:'kidney/manifest-v4.json',imageRoot:'kidney/',label:'Kidney',posture:'prone'}};
let activeOrgan='liver',datasetGeneration=0,switching=false,wideView=false,environment,anatomyAsset;
const manifests=new Map(),anatomies=new Map();
const inputs = ['position','rotation','shadow','detail'].map($);
const canvas = $('us-canvas'), ctx = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let manifest, current, previous, transition, desired, generation = 0;
let displayMode='output', split=.5, showGuidance=false, scanning=false, scanDirection=1, sweep=null, scanEpoch=0;
let renderer, scene, camera, orbit, asset, fan, fanGroup, robotNodes={}, joints, baseMatrix, initialTarget;
let liveQ, dirty=true, sceneReady=false, inView=true, lastPaint=0, lastTick=0, measurements=[], anatomyCenter, cameraTransition;
let probeMotion,wheelZoom,lastFrame=0,lastShadowUpdate=0,shadowDirty=true;
const blendFrom=document.createElement('canvas'),blendCtx=blendFrom.getContext('2d');
blendFrom.width=canvas.width;blendFrom.height=canvas.height;
const cache=new Map(), overlays=new Map(),requestPins=new Map();
const imageStage=$('image-wrap');
// Move the same control between layouts, keeping its state and event handler.
const compactLayout=matchMedia('(max-width:720px)');
function placePlayback(){const mobile=compactLayout.matches&&!$('explorer').classList.contains('is-expanded');$(mobile?'mobile-playback':'playback-actions').prepend($('auto-scan'));}
compactLayout.addEventListener('change',placePlayback);placePlayback();
const labelLegend=$('label-legend'),legendItems=new Map();
let legendLayoutKey='',legendMask=-1;
for(const [id,name,color] of labelPalette){
 const item=document.createElement('span'),swatch=document.createElement('i');item.className='label-legend-item';item.setAttribute('role','listitem');item.dataset.label=String(id);
 swatch.style.backgroundColor=color;swatch.setAttribute('aria-hidden','true');item.append(swatch,document.createTextNode(name));labelLegend.append(item);legendItems.set(id,item);
}
function syncLabelLegend(record){
 const enabled=displayMode==='label'&&record?.referenceMode==='label';labelLegend.hidden=!enabled;$('image-meta').hidden=enabled;
 if(!enabled)return;
 const poses=labelPoseMasks[record.organ],layoutKey=`${record.organ}:${labelLegend.clientWidth}`;
 if(layoutKey!==legendLayoutKey){
  // Reserve the case's full palette height once; only its present labels are
  // shown, without changing the image size as an automatic sweep advances.
  const all=poses.reduce((mask,value)=>mask|value,0);
  for(const [id,item] of legendItems)item.hidden=!(all&(1<<id));
  labelLegend.style.height='auto';labelLegend.style.height=`${labelLegend.getBoundingClientRect().height}px`;legendLayoutKey=layoutKey;legendMask=-1;
 }
 const mask=record.blend?poses[record.blend.a.pose.index]|poses[record.blend.b.pose.index]:poses[record.pose.index];
 if(mask!==legendMask){for(const [id,item] of legendItems)item.hidden=!(mask&(1<<id));legendMask=mask;}
}
const setStatus = text => { $('demo-status').textContent=text; };
const signed = (v,unit) => `${v>0?'+':v<0?'−':''}${Math.abs(v)}${unit}`;
const same = (a,b) => ['position','rotation','shadow','detail'].every(k=>a[k]===b[k]);
function readState(){ return Object.fromEntries(inputs.map(i=>[i.id,Math.round(Number(i.value))])); }
function paintValues(){
 const s=readState();
 if(manifest){
  $('position-value').textContent=signed(Math.round(manifest.positions[s.position]*10)/10,' mm');
  $('rotation-value').textContent=signed(manifest.rotations[s.rotation],'°');
  const sh=manifest.shadows[s.shadow];$('shadow-value').textContent=sh===0?'Default':signed(sh,'%');
  const shadowAvailable=poseOf(s).shadow_control!==false;
  $('shadow').disabled=switching||!shadowAvailable;
  $('shadow').title=shadowAvailable?'':'This view has no adjustable shadow region. Move the probe to another view.';
  if(!shadowAvailable)$('shadow-value').textContent='Not active';
  $('detail-value').textContent=manifest.details[s.detail].toFixed(2);
 }
 inputs.forEach(i=>{i.style.setProperty('--fill',`${100*(i.value-i.min)/(i.max-i.min)}%`);i.setAttribute('aria-valuetext',$(i.id+'-value').textContent);});
}
function poseOf(state){return manifest.poses[state.position*manifest.rotations.length+state.rotation];}
const keyFor = (pose,name,organ=activeOrgan) => `${organ}/${String(pose).padStart(3,'0')}/${name}`;
const imageKey = state => keyFor(poseOf(state).index, `us-${state.shadow}-${state.detail}`);
let neededKeys=new Set(), prefetchTimer, sceneSettled=false;
function trimCache(){
 const keep=new Set([...(current?.cacheKeys||[]),...[...requestPins.values()].flatMap(keys=>[...keys])]);
 const available=[...cache].filter(([key,r])=>!keep.has(key)&&r.bitmap).sort((a,b)=>a[1].used-b[1].used);
 let bytes=[...cache.values()].reduce((sum,r)=>sum+(r.bitmap?r.bitmap.width*r.bitmap.height*4:0),0);
 const budget=(matchMedia('(max-width:720px)').matches?36:64)*1024*1024;
 while(bytes>budget && available.length){const [key,r]=available.shift();bytes-=r.bitmap.width*r.bitmap.height*4;r.bitmap.close();cache.delete(key);}
 while(overlays.size>16)overlays.delete(overlays.keys().next().value);
 $('explorer').dataset.imageCache=JSON.stringify({decoded:[...cache.values()].filter(r=>r.bitmap).length,pending:[...cache.values()].filter(r=>!r.bitmap).length});
}
async function loadImage(key,priority='high',forceTrack=false,pinToken){
 const [organ,index,name]=key.split('/'),m=await getManifest(organ),pose=m.poses[Number(index)];
 const path=`${datasets[organ].imageRoot}${m.tracks||'tracks'}/${name}-r${String(pose.j).padStart(2,'0')}.webp`;
 const preview=name===`us-${m.defaults.shadow}-${m.defaults.detail}`&&pose.i===m.defaults.position&&pose.j===m.defaults.rotation&&!forceTrack&&!cache.has(path);
 const cacheKey=preview?`${datasets[organ].imageRoot}${m.preview}`:path;
 if(pinToken!==undefined)requestPins.get(pinToken)?.add(cacheKey);
 const tile=(image,cached=false)=>({image,sx:preview?0:pose.i*256,sy:0,sw:256,sh:256,cacheKey,cached});
 if(cache.has(cacheKey)){const r=cache.get(cacheKey),cached=!!r.bitmap;r.used=performance.now();return r.promise.then(image=>tile(image,cached));}
 const record={used:performance.now(),controller:new AbortController()};
 record.promise=fetch(new URL(cacheKey,root),{signal:record.controller.signal,priority})
  .then(r=>{if(!r.ok)throw Error(`Image ${key} unavailable`);return r.blob();})
  .then(createImageBitmap).then(bitmap=>{record.bitmap=bitmap;return bitmap;})
  .catch(error=>{if(cache.get(cacheKey)===record)cache.delete(cacheKey);throw error;});
 cache.set(cacheKey,record);return record.promise.then(tile);
}
function prefetch(state){
 clearTimeout(prefetchTimer);
 if(!sceneSettled||scanning||navigator.connection?.saveData||document.hidden||!inView)return;
 const token=generation;
 prefetchTimer=setTimeout(async()=>{
  const candidates=[imageKey(state)];
  if(displayMode!=='output')candidates.push(keyFor(poseOf(state).index,displayMode));
  if(showGuidance)candidates.push(keyFor(poseOf(state).index,`guidance-${state.shadow}`));
  // Each track contains the entire position sweep. Nearby rotations warm first.
  for(const offset of [1,-1,2,-2]){
   const next={...state,rotation:state.rotation+offset};
   if(next.rotation<0||next.rotation>=manifest.rotations.length)continue;
   candidates.push(imageKey(next));
  }
  // One small speculative request at a time; foreground interaction always wins.
  for(const key of [...new Set(candidates)]){
   if(token!==generation||document.hidden||!inView)return;
   try{await loadImage(key,'low',true);trimCache();}catch{}
  }
 },120);
}
function moveProbe(state,animate=true){
 const q=poseOf(state).q;
 if(!liveQ||!animate||reducedMotion){probeMotion=null;liveQ=[...q];applyPose(liveQ);return;}
 if(q.every((value,i)=>Math.abs(value-(probeMotion?.to[i]??liveQ[i]))<1e-7))return;
 probeMotion={from:[...liveQ],to:q,start:performance.now(),duration:180};
 $('scene').dataset.motionActive='true';
}
async function warmControl(id){
 if(!manifest||navigator.connection?.saveData)return;
 const state=readState(),token=datasetGeneration;
 if(id==='position'){await loadImage(imageKey(state),'low',true).catch(()=>{});return;}
 if(id!=='shadow'&&id!=='detail')return;
 for(const value of [0,4,1,3,2]){
  if(token!==datasetGeneration)return;
  try{await loadImage(imageKey({...state,[id]:value}),'low',true);trimCache();}catch{}
 }
}
async function requestState(state,animate=true){
 desired={...state};paintValues();clearTimeout(prefetchTimer);moveProbe(state,animate);
 const token=++generation,started=performance.now(),pose=poseOf(state);
 requestPins.set(token,new Set());
 const keys=[imageKey(state)];
 if(displayMode!=='output')keys.push(keyFor(pose.index,displayMode));
 if(showGuidance)keys.push(keyFor(pose.index,`guidance-${state.shadow}`));
 neededKeys=new Set(keys);
 // Let useful in-flight tracks finish; interrupting every drag discards work.
 let loadingTimer=setTimeout(()=>{if(token===generation)$('image-loading').hidden=false;},350);
 try{
  const images=await Promise.all(keys.map(key=>loadImage(key,'high',false,token))),cached=images.every(t=>t.cached);
  clearTimeout(loadingTimer);if(token!==generation)return;
  const changed=current&&!same(current.state,state);
  if(changed){blendCtx.clearRect(0,0,blendFrom.width,blendFrom.height);blendCtx.drawImage(canvas,0,0);previous=true;}else previous=null;
  current={organ:activeOrgan,state:{...state},pose,bitmap:images[0],reference:displayMode==='output'?null:images[1],referenceMode:displayMode,
   guidanceBitmap:showGuidance?images.at(-1):null,keys,cacheKeys:images.map(x=>x.cacheKey)};
  transition=previous&&animate&&!reducedMotion?{start:performance.now(),duration:180}:null;
  if(!transition)previous=null;
  $('image-loading').hidden=true;
  $('explorer').dataset.pose=String(pose.index);$('explorer').dataset.state=JSON.stringify(state);
  $('explorer').dataset.lastImageLoad=JSON.stringify({ms:Math.round(performance.now()-started),cached,files:keys.length});
  if(!$('explorer').dataset.imageReadyMs)$('explorer').dataset.imageReadyMs=String(Math.round(performance.now()));
  setStatus('Drag to orbit · Scroll to zoom');
  dirty=true;drawUltrasound(transition?0:1);trimCache();prefetch(state);
 }catch(error){
  clearTimeout(loadingTimer);if(token!==generation||error.name==='AbortError')return;
  console.error('[SonoBridge]',error);stopScan();$('image-loading').hidden=true;
  if(current){for(const i of inputs)i.value=current.state[i.id];desired={...current.state};paintValues();moveProbe(current.state);}
  setStatus('This view could not be loaded. Select another position or reset to retry.');
 }finally{requestPins.delete(token);trimCache();}
}
function fanPath(w,h){
 const R=manifest.probe.radius_mm*.001,far=R+manifest.depth_mm*.001,half=manifest.probe.sector_angle_deg*.5*Math.PI/180,W=2*far*Math.sin(half),H=far-R*Math.cos(half);
 const path=new Path2D();
 const point=(r,a)=>[(r*Math.sin(a)/W+.5)*w,(r*Math.cos(a)-R*Math.cos(half))/H*h];
 let first=true;
 for(let i=0;i<=90;i++){const p=point(R,-half+2*half*i/90);first?path.moveTo(...p):path.lineTo(...p);first=false;}
 for(let i=90;i>=0;i--)path.lineTo(...point(far,-half+2*half*i/90));
 path.closePath();return path;
}
function tile(bitmap,alpha=1){if(!bitmap)return;ctx.globalAlpha=alpha;if(bitmap.image)ctx.drawImage(bitmap.image,bitmap.sx,bitmap.sy,bitmap.sw,bitmap.sh,0,0,canvas.width,canvas.height);else ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);ctx.globalAlpha=1;}
function guidance(record){
 if(!record.guidanceBitmap)return null;
 const key=`${record.organ}:${record.pose.index}:${record.state.shadow}`;
 if(overlays.has(key))return overlays.get(key);
 const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d',{willReadFrequently:true});
 const t=record.guidanceBitmap;x.drawImage(t.image,t.sx,t.sy,t.sw,t.sh,0,0,256,256);
 const pixels=x.getImageData(0,0,256,256);
 cleanVisibilityContours(pixels.data,256,256);
 for(let i=0;i<pixels.data.length;i+=4){const support=pixels.data[i],edge=pixels.data[i+1];pixels.data[i]=edge?91:245;pixels.data[i+1]=edge?180:189;pixels.data[i+2]=edge?218:76;pixels.data[i+3]=edge?225:Math.round(support*.7);}
 x.putImageData(pixels,0,0);overlays.set(key,c);while(overlays.size>16)overlays.delete(overlays.keys().next().value);return c;
}
function drawRecord(record,alpha=1){
 if(!record)return;
 if(record.blend){drawRecord(record.blend.a,alpha);drawRecord(record.blend.b,alpha*record.blend.u);return;}
 const comparing=displayMode!=='output'&&record.reference&&record.referenceMode===displayMode;
 if(comparing){
  ctx.save();ctx.beginPath();ctx.rect(0,0,canvas.width*split,canvas.height);ctx.clip();tile(record.reference,alpha);ctx.restore();
  ctx.save();ctx.beginPath();ctx.rect(canvas.width*split,0,canvas.width,canvas.height);ctx.clip();tile(record.bitmap,alpha);ctx.restore();
 }else tile(record.bitmap,alpha);
 if(showGuidance){const overlay=guidance(record);if(overlay){ctx.save();if(comparing){ctx.beginPath();ctx.rect(canvas.width*split,0,canvas.width,canvas.height);ctx.clip();}tile(overlay,alpha);ctx.restore();}}
}
function drawUltrasound(u=1){
 syncLabelLegend(current);
 ctx.clearRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.save();ctx.clip(fanPath(canvas.width,canvas.height));
 if(previous&&u<1){ctx.drawImage(blendFrom,0,0);drawRecord(current,u);}else drawRecord(current);
 ctx.restore();
}
function matrix(rows){return new THREE.Matrix4().set(...rows.flat());}
function applyPose(q){
 if(!sceneReady||!q)return;
 const transforms={base:baseMatrix.clone()};let k=0;
 for(const j of joints){const T=transforms[j.parent].clone().multiply(j.T);if(j.moving)T.multiply(new THREE.Matrix4().makeRotationAxis(j.axis,q[k++]));transforms[j.child]=T;}
 for(const [name,node] of Object.entries(robotNodes)){node.matrixAutoUpdate=false;node.matrix.copy(transforms[name]);node.matrixWorldNeedsUpdate=true;}
 const face=transforms.fr3_link8.clone().multiply(new THREE.Matrix4().makeTranslation(...manifest.kinematics.face_offset));
 fanGroup.matrixAutoUpdate=false;fanGroup.matrix.copy(face);fanGroup.matrixWorldNeedsUpdate=true;
 dirty=true;shadowDirty=true;
}
function makeFan(){
 if(fanGroup){scene.remove(fanGroup);fanGroup.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});}
 fanGroup=new THREE.Group();scene.add(fanGroup);
 const near=[],far=[],vertices=[],indices=[];const n=91;
 const radius=manifest.probe.radius_mm*.001,farRadius=radius+manifest.depth_mm*.001,angle=manifest.probe.sector_angle_deg;
 for(let j=0;j<n;j++){const t=(-angle/2+angle*j/(n-1))*Math.PI/180;near.push(new THREE.Vector3(radius*Math.sin(t),0,radius*Math.cos(t)-radius));far.push(new THREE.Vector3(farRadius*Math.sin(t),0,farRadius*Math.cos(t)-radius));}
 for(const p of [...near,...far])vertices.push(...p.toArray());
 for(let i=0;i<n-1;i++)indices.push(i,n+i,i+1,i+1,n+i,n+i+1);
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();
 fan=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0x81bbc4,transparent:true,opacity:.065,side:THREE.DoubleSide,depthWrite:false,depthTest:false}));fan.renderOrder=20;fanGroup.add(fan);
 const outline=[...near,far[n-1],...far.slice().reverse(),near[0]];
 const lines=new THREE.Line(new THREE.BufferGeometry().setFromPoints(outline),new THREE.LineBasicMaterial({color:0x276f79,transparent:true,opacity:.95,depthTest:false}));lines.renderOrder=21;fanGroup.add(lines);
}
function resetCamera(animate=false){
 if(!camera||!asset||!sceneReady)return;
 wheelZoom=null;
 asset.updateMatrixWorld(true);
 environment?.setScanView(!wideView);
 camera.fov=wideView?35:42;camera.updateProjectionMatrix();
 const bounds=new THREE.Box3().setFromObject(asset);
 if(wideView)environment.group.traverse(o=>{if(o.isMesh&&o.geometry.type!=='PlaneGeometry'&&o.visible)bounds.expandByObject(o);});
 const target=bounds.getCenter(new THREE.Vector3());
 // In the scan view, fit the entire robot and CT anatomy, not the bed or plinth.
 // Looking from the patient's side brings the organs forward in perspective.
 const direction=(wideView?new THREE.Vector3(-1.6,-1.9,1.3):activeOrgan==='kidney'?new THREE.Vector3(-.6,1.65,1.22):new THREE.Vector3(-.9,-1.5,.62)).normalize();
 // Fit actual mesh vertices: rotated bounding boxes include empty corners and
 // needlessly pull the camera away from the probe. This is a single linear pass.
 const right=new THREE.Vector3().crossVectors(camera.up,direction).normalize(),up=new THREE.Vector3().crossVectors(direction,right),p=new THREE.Vector3();
 const tanY=Math.tan(camera.fov*Math.PI/360),tanX=tanY*camera.aspect;let distance=.45;
 const fitMesh=o=>{if(!o.isMesh||!o.visible||o.geometry.type==='PlaneGeometry')return;const a=o.geometry.attributes.position;
  for(let i=0;i<a.count;i++){p.fromBufferAttribute(a,i).applyMatrix4(o.matrixWorld).sub(target);distance=Math.max(distance,p.dot(direction)+Math.max(Math.abs(p.dot(right))/(tanX*.9),Math.abs(p.dot(up))/(tanY*.8),camera.near+.02));}
 };
 asset.traverse(fitMesh);if(wideView)environment.group.traverse(fitMesh);
 const position=target.clone().addScaledVector(direction,distance);
 $('scene').dataset.cameraDistance=distance.toFixed(5);
 if(animate===true&&!reducedMotion)cameraTransition={start:performance.now(),from:camera.position.clone(),to:position,targetFrom:orbit.target.clone(),targetTo:target.clone()};
 else{cameraTransition=null;orbit.target.copy(target);camera.position.copy(position);orbit.update();}
 $('camera-overview').textContent=wideView?'Focus scan':'Full setup';$('camera-overview').setAttribute('aria-pressed',String(wideView));dirty=true;
}
async function geometryBytes(path,revision){
 const compressed=typeof DecompressionStream!=='undefined';
 const url=new URL(path+(compressed?'.gz':''),root);if(revision)url.searchParams.set('v',revision);
 const response=await fetch(url);
 if(!response.ok)throw Error('3D asset unavailable');
 return compressed?new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer():response.arrayBuffer();
}
function getManifest(organ){
 if(!manifests.has(organ))manifests.set(organ,fetch(new URL(datasets[organ].manifest,root)).then(r=>{if(!r.ok)throw Error('Acquisition data unavailable');return r.json();}).catch(e=>{manifests.delete(organ);throw e;}));
 return manifests.get(organ);
}
async function getAnatomy(organ){
 if(!anatomies.has(organ))anatomies.set(organ,getManifest(organ).then(m=>geometryBytes(`${datasets[organ].imageRoot}${m.anatomy}`)).then(bytes=>new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes,root.href)).then(g=>{
  const materials={Liver:[0x865146,organ==='liver'?1:.32],Kidneys:[0x966e57,organ==='kidney'?1:.55],Vessels:[0x95636b,.5],Bones:[0xb6b1a1,.24],Skin:[0x9caaa7,.016],Spleen:[0x84758e,.38],Gallbladder:[0x7e9468,.50],Pancreas:[0xb29d79,.44],Stomach:[0xac977c,.30],Lungs:[0x7695a7,.20],Myocardium:[0x946275,.30],Heart:[0x9c6d7c,.30],Intestines:[0x93a47d,.22]};
  g.scene.traverse(o=>{if(!o.isMesh)return;const name=o.name.replace('anatomy_',''),[color,opacity]=materials[name]||[0x9a9183,.30];o.material=new THREE.MeshStandardMaterial({color,roughness:.83,metalness:0,envMapIntensity:.24,transparent:opacity<1,opacity,depthWrite:opacity>=1,side:THREE.FrontSide});o.castShadow=opacity===1;o.receiveShadow=opacity===1;o.renderOrder=name==='Skin'?8:2;});return g.scene;
 }).catch(e=>{anatomies.delete(organ);throw e;}));
 return anatomies.get(organ);
}
function attachAnatomy(model){
 if(anatomyAsset)asset.remove(anatomyAsset);anatomyAsset=model;asset.add(model);model.updateMatrixWorld(true);
 const skin=model.getObjectByName('anatomy_Skin'),target=model.getObjectByName(activeOrgan==='liver'?'anatomy_Liver':'anatomy_Kidneys');
 anatomyCenter=new THREE.Box3().setFromObject(target).getCenter(new THREE.Vector3());
 const abdominalAnchor=new THREE.Box3().setFromObject(model.getObjectByName('anatomy_Kidneys')).getCenter(new THREE.Vector3());
 environment.alignPatient(new THREE.Box3().setFromObject(skin),datasets[activeOrgan].posture,abdominalAnchor);environment.setPatientVisible($('patient-toggle').checked);
 $('scene').dataset.patientAlignment=JSON.stringify(environment.group.userData.patientAlignment);
 makeFan();applyPose(liveQ||poseOf(manifest.defaults).q);resetCamera();dirty=true;
}
async function setupScene(){
 const runtimePromise=import('../vendor/scene-runtime.js?v=5');
 const robotPromise=geometryBytes('robot.compact.glb');
 const [runtime,robotBytes,patientBytes]=await Promise.all([runtimePromise,robotPromise,geometryBytes('patient-v2.compact.glb','2')]);
 THREE=runtime;({OrbitControls,GLTFLoader,RoomEnvironment,MeshoptDecoder}=runtime);
 const container=$('scene');renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.94;
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;container.appendChild(renderer.domElement);
 scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(35,1,.02,20);camera.up.set(0,0,1);
 orbit=new OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;orbit.dampingFactor=.075;orbit.rotateSpeed=.65;orbit.zoomSpeed=.35;orbit.minDistance=.45;orbit.maxDistance=5;orbit.maxPolarAngle=Math.PI*.8;orbit.addEventListener('change',()=>dirty=true);orbit.addEventListener('start',()=>{cameraTransition=null;wheelZoom=null;});
 // OrbitControls damps rotation but applies wheel distance instantly. Normalize
 // wheel units, bound each impulse, then ease distance in the animation loop.
 renderer.domElement.addEventListener('wheel',event=>{
  event.preventDefault();event.stopImmediatePropagation();cameraTransition=null;
  const unit=event.deltaMode===1?16:event.deltaMode===2?container.clientHeight:1;
  const impulse=Math.max(-80,Math.min(80,event.deltaY*unit));
  const from=wheelZoom?.target??camera.position.distanceTo(orbit.target);
  wheelZoom={target:Math.max(orbit.minDistance,Math.min(orbit.maxDistance,from*Math.exp(impulse*.00045)))};dirty=true;
 },{capture:true,passive:false});
 const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();scene.environment=pmrem.fromScene(room,.04).texture;room.dispose();pmrem.dispose();
 const hemi=new THREE.HemisphereLight(0xfffaf4,0xb2bab9,1.4);hemi.position.set(0,0,3);scene.add(hemi);
 const sun=new THREE.DirectionalLight(0xfffaf3,1.65);sun.position.set(-1,-1.5,3);sun.target.position.set(0,.2,.55);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-1.5,right:1.5,top:1.7,bottom:-1.7,near:.1,far:6});sun.shadow.bias=-.0002;sun.shadow.normalBias=.008;sun.shadow.radius=3;scene.add(sun,sun.target);
 const fill=new THREE.DirectionalLight(0xdce9ef,.8);fill.position.set(1,1,2);scene.add(fill);
 asset=new THREE.Group();scene.add(asset);const gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(robotBytes,root.href);asset.add(gltf.scene);
 gltf.scene.traverse(o=>{if(o.name==='web_base'||/^web_fr3_link[0-8]$/.test(o.name))robotNodes[o.name.slice(4)]=o;if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
 const patient=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(patientBytes,root.href);
 environment=createEnvironment(THREE,scene,patient.scene);
 baseMatrix=matrix(manifest.kinematics.base);joints=manifest.kinematics.joints.map(j=>({...j,T:matrix(j.origin),axis:new THREE.Vector3(...j.axis)}));makeFan();
 sceneReady=true;applyPose(liveQ||poseOf(manifest.defaults).q);resetCamera();
 new ResizeObserver(()=>{const w=container.clientWidth,h=container.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();resetCamera();dirty=true;}).observe(container);
 $('scene-loading').classList.add('anatomy-progress');$('scene-loading').querySelector('span:last-child').textContent='Loading anatomy';container.dataset.robotReadyMs=String(Math.round(performance.now()));
 const model=await getAnatomy(activeOrgan);attachAnatomy(model);
 $('scene-loading').hidden=true;container.dataset.ready='true';container.dataset.readyMs=String(Math.round(performance.now()));sceneSettled=true;prefetch(readState());
 document.querySelectorAll('[data-organ]').forEach(b=>b.disabled=false);
 // Only the small default kidney record is warmed. Its 3D anatomy stays on demand.
 const other=activeOrgan==='liver'?'kidney':'liver';
 if(!navigator.connection?.saveData)setTimeout(()=>getManifest(other).then(m=>loadImage(keyFor(m.defaults.position*m.rotations.length+m.defaults.rotation,`us-${m.defaults.shadow}-${m.defaults.detail}`,other),'low')).catch(()=>{}),1500);
}
function configureDataset(){
 const mappings={position:manifest.positions,rotation:manifest.rotations,shadow:manifest.shadows,detail:manifest.details};
 for(const input of inputs){input.max=mappings[input.id].length-1;input.value=manifest.defaults[input.id];}
 for(const [id,values,unit] of [['position',manifest.positions,' mm'],['rotation',manifest.rotations,'°']]){$(id+'-min').textContent=signed(values[0],unit);$(id+'-max').textContent=signed(values.at(-1),unit);}
 $('scan-specs').textContent=`${manifest.frequency_mhz.toFixed(1)} MHz · ${manifest.depth_mm} mm depth`;
 $('scene').setAttribute('aria-label',`Interactive ${datasets[activeOrgan].label.toLowerCase()} anatomy and robotic probe, patient ${datasets[activeOrgan].posture}${activeOrgan==='kidney'?' with back facing up':''}`);
 $('scene-context').textContent=activeOrgan==='liver'?'Liver · Supine':'Kidney · Prone · Back facing up';
 imageStage.style.aspectRatio=String(manifest.aspect);resizeImage();paintValues();
 $('explorer').dataset.organ=activeOrgan;$('explorer').dataset.case=manifest.case_id;
 document.querySelectorAll('[data-organ]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.organ===activeOrgan));b.classList.remove('is-loading');});
}
function resizeImage(){
 if(!manifest)return;syncLabelLegend(current);const box=document.querySelector('.image-stage'),style=getComputedStyle(box);
 const width=box.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),height=box.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
 const w=Math.min(width,height*manifest.aspect,$('explorer').classList.contains('is-expanded')?650:500);imageStage.style.width=`${w}px`;imageStage.style.height=`${w/manifest.aspect}px`;
}
async function switchOrgan(organ){
 $('explorer').dataset.switchStartMs=String(Math.round(performance.now()));
 const token=++datasetGeneration;stopScan();clearTimeout(prefetchTimer);generation++;switching=true;
 inputs.forEach(i=>i.disabled=true);document.querySelectorAll('[data-view]').forEach(b=>b.disabled=true);$('guidance-toggle').disabled=true;$('reset-demo').disabled=true;$('auto-scan').disabled=true;
 document.querySelectorAll('[data-organ]').forEach(b=>b.classList.toggle('is-loading',b.dataset.organ===organ));
 setStatus(`Loading the ${datasets[organ].label.toLowerCase()} demo…`);
 try{
  const next=await getManifest(organ);const index=next.defaults.position*next.rotations.length+next.defaults.rotation;
  const keys=[keyFor(index,`us-${next.defaults.shadow}-${next.defaults.detail}`,organ)];
  if(displayMode!=='output')keys.push(keyFor(index,displayMode,organ));if(showGuidance)keys.push(keyFor(index,`guidance-${next.defaults.shadow}`,organ));
  const modelPromise=sceneReady?getAnatomy(organ):Promise.resolve(null);
  const [model]=await Promise.all([modelPromise,...keys.map(key=>loadImage(key))]);if(token!==datasetGeneration)return;
  activeOrgan=organ;manifest=next;previous=null;current=null;transition=null;probeMotion=null;liveQ=null;wideView=false;
  configureDataset();if(sceneReady){baseMatrix=matrix(next.kinematics.base);joints=next.kinematics.joints.map(j=>({...j,T:matrix(j.origin),axis:new THREE.Vector3(...j.axis)}));attachAnatomy(model);}
  await requestState(next.defaults,false);$('explorer').dataset.switchReadyMs=String(Math.round(performance.now()));
 }catch(error){if(token!==datasetGeneration)return;console.error('[SonoBridge] organ switch',error);setStatus('This view could not be loaded. Select the organ again to retry.');}
 finally{if(token===datasetGeneration){switching=false;inputs.forEach(i=>i.disabled=false);paintValues();document.querySelectorAll('[data-view]').forEach(b=>b.disabled=false);$('guidance-toggle').disabled=false;$('reset-demo').disabled=false;$('auto-scan').disabled=false;document.querySelectorAll('[data-organ]').forEach(b=>b.classList.remove('is-loading'));}}
}
function tick(now){
 requestAnimationFrame(tick);const dt=Math.min(.05,Math.max(.001,(now-lastFrame)/1000));lastFrame=now;if(!inView)return;
 if(scanning&&sweep)paintSweep(now);
 if(cameraTransition){const t=cameraTransition,u=Math.min(1,(now-t.start)/450),s=u*u*(3-2*u);camera.position.lerpVectors(t.from,t.to,s);orbit.target.lerpVectors(t.targetFrom,t.targetTo,s);dirty=true;if(u===1)cameraTransition=null;}
 if(wheelZoom&&camera){const radius=camera.position.distanceTo(orbit.target),next=radius+(wheelZoom.target-radius)*(1-Math.exp(-dt/.13));camera.position.sub(orbit.target).multiplyScalar(next/radius).add(orbit.target);dirty=true;if(Math.abs(next-wheelZoom.target)<.0001)wheelZoom=null;$('scene').dataset.cameraDistance=next.toFixed(5);}
 if(probeMotion){const t=probeMotion,u=Math.min(1,(now-t.start)/t.duration),s=u*u*(3-2*u);if(!t.painted){$('scene').dataset.motionLatencyMs=String(Math.round(now-t.start));t.painted=true;}liveQ=t.to.map((q,i)=>t.from[i]+(q-t.from[i])*s);applyPose(liveQ);if(u===1){probeMotion=null;$('scene').dataset.motionActive='false';}}
 let u=1;
 if(transition&&current){u=Math.min(1,(now-transition.start)/transition.duration);drawUltrasound(u);if(u===1){transition=null;previous=null;trimCache();}}
 orbit?.update();
 if(renderer&&sceneReady&&dirty){if(shadowDirty&&now-lastShadowUpdate>33){renderer.shadowMap.needsUpdate=true;shadowDirty=false;lastShadowUpdate=now;}renderer.render(scene,camera);dirty=false;
  if(lastPaint&&now-lastPaint<250){measurements.push(now-lastPaint);if(measurements.length>120)measurements.shift();}
  lastPaint=now;if(now-lastTick>1000){lastTick=now;$('scene').dataset.renderStats=JSON.stringify({fps:measurements.length?Math.round(1000/(measurements.reduce((a,b)=>a+b)/measurements.length)):0,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,cachedImages:cache.size});}
 }
}
function stopScan(keepInput=false){
 if(scanning&&!keepInput&&current?.playbackPosition!==undefined)$('position').value=current.playbackPosition;
 scanning=false;sweep=null;scanEpoch++;$('position').step='1';$('position').value=Math.round(Number($('position').value));
 $('image-loading').hidden=true;
 $('auto-scan').innerHTML='<span class="play-icon">▷</span> Auto scan';$('auto-scan').setAttribute('aria-pressed','false');
 $('scene').dataset.playbackActive='false';
}
function paintSweep(now){
 const s=sweep,last=s.records.length-1,p=sweepPosition(now-s.start,s.phase,last),i=Math.min(last-1,Math.floor(p)),u=p-i;
 const a=s.records[i],b=s.records[i+1],near=u<.5?a:b;
 liveQ=s.curve(p);applyPose(liveQ);
 current={...near,blend:{a,b,u},playbackPosition:p};previous=null;transition=null;drawUltrasound();
 const angle=s.phase+(now-s.start)*2*Math.PI/16000;scanDirection=Math.sin(angle)>=0?1:-1;
 if(s.lastFrame)s.gaps.push(now-s.lastFrame);s.lastFrame=now;if(s.gaps.length>240)s.gaps.shift();
 if(now-s.lastUI>45){
  s.lastUI=now;$('position').value=p;const mm=manifest.positions[i]*(1-u)+manifest.positions[i+1]*u;
  $('position-value').textContent=signed(Math.round(mm*10)/10,' mm');$('position').style.setProperty('--fill',`${100*p/last}%`);$('position').setAttribute('aria-valuetext',$('position-value').textContent);
  $('explorer').dataset.pose=String(near.pose.index);$('explorer').dataset.state=JSON.stringify(near.state);
 }
 if(now-s.lastReport>1000){
  s.lastReport=now;const gaps=[...s.gaps].sort((a,b)=>a-b);
  $('scene').dataset.playbackStats=JSON.stringify({clock:'continuous',nativeViews:s.records.length,position:p,blend:u,p95FrameMs:Math.round(gaps[Math.floor(gaps.length*.95)]||0),maxFrameMs:Math.round(gaps.at(-1)||0)});
 }
}
inputs.forEach(input=>{input.addEventListener('input',()=>{stopScan(input.id==='position');requestState(readState());});input.addEventListener('pointerdown',()=>warmControl(input.id));input.addEventListener('focus',()=>warmControl(input.id));});
$('guidance-toggle').addEventListener('change',e=>{stopScan();showGuidance=e.target.checked;requestState(readState(),false);});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{
 stopScan();
 displayMode=button.dataset.view;document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));
 const comparing=displayMode!=='output';
 for(const id of ['compare-range','compare-divider','compare-labels'])$(id).hidden=!comparing;
 $('compare-source').textContent=displayMode==='label'?'Label map':'CT';
 canvas.setAttribute('aria-label',comparing?`${displayMode==='label'?'Anatomical label map':'CT slice'} and SonoBridge comparison`:'SonoBridge ultrasound output');
 requestState(readState(),false);
}));
$('compare-range').addEventListener('input',e=>{split=Number(e.target.value)/100;$('compare-divider').style.left=`${split*100}%`;drawUltrasound();});
$('patient-toggle').addEventListener('change',e=>{environment?.setPatientVisible(e.target.checked);dirty=true;});
$('camera-overview').addEventListener('click',()=>{wideView=!wideView;resetCamera(true);});
document.querySelectorAll('[data-organ]').forEach(b=>b.addEventListener('click',()=>switchOrgan(b.dataset.organ)));
$('camera-reset').addEventListener('click',()=>{wideView=false;resetCamera(true);});
function expandViewer(expanded){
 $('explorer').classList.toggle('is-expanded',expanded);document.body.classList.toggle('viewer-expanded',expanded);document.documentElement.classList.toggle('viewer-expanded',expanded);
 placePlayback();
 $('fullscreen').setAttribute('aria-label',expanded?'Exit expanded viewer':'Expand interactive viewer');
 $('fullscreen').title=expanded?'Exit expanded view (Esc)':'Expand viewer';$('fullscreen').textContent=expanded?'×':'⛶';dirty=true;
}
$('fullscreen').addEventListener('click',()=>expandViewer(!$('explorer').classList.contains('is-expanded')));
document.addEventListener('keydown',e=>{if(e.key==='Escape')expandViewer(false);});
$('reset-demo').addEventListener('click',async()=>{
 stopScan();showGuidance=false;$('guidance-toggle').checked=false;$('patient-toggle').checked=true;environment?.setPatientVisible(true);wideView=false;
 Object.entries(robotNodes).forEach(([name,node])=>node.visible=true);
 split=.5;$('compare-range').value=50;$('compare-divider').style.left='50%';
 document.querySelector('[data-view="output"]').click();
 for(const input of inputs)input.value=manifest.defaults[input.id];await requestState(readState(),false);resetCamera();
});
$('auto-scan').addEventListener('click',async()=>{
 if(scanning)return stopScan();scanning=true;const epoch=++scanEpoch,token=++generation,state=readState(),started=performance.now();clearTimeout(prefetchTimer);
 requestPins.set(token,new Set());
 $('auto-scan').innerHTML='<span class="play-icon">Ⅱ</span> Pause scan';$('auto-scan').setAttribute('aria-pressed','true');
 const keys=[imageKey(state)];if(displayMode!=='output')keys.push(keyFor(poseOf(state).index,displayMode));if(showGuidance)keys.push(keyFor(poseOf(state).index,`guidance-${state.shadow}`));
 try{
  const tiles=await Promise.all(keys.map(key=>loadImage(key,'high',true,token)));if(!scanning||epoch!==scanEpoch||token!==generation)return;
  const cacheKeys=tiles.map(t=>t.cacheKey),records=manifest.positions.map((_,position)=>{
   const pose=poseOf({...state,position}),at=t=>({...t,sx:position*256});
   return {organ:activeOrgan,state:{...state,position},pose,bitmap:at(tiles[0]),reference:displayMode==='output'?null:at(tiles[1]),referenceMode:displayMode,guidanceBitmap:showGuidance?at(tiles.at(-1)):null,keys,cacheKeys};
  });
  probeMotion=null;transition=null;previous=null;current.cacheKeys=cacheKeys;$('position').step='any';
  const resumePosition=current&&same(current.state,state)?current.playbackPosition??state.position:state.position;
  sweep={start:performance.now(),phase:sweepPhase(resumePosition,records.length-1,scanDirection),curve:createJointCurve(records.map(r=>r.pose.q)),records,gaps:[],lastUI:0,lastReport:0,lastFrame:0};
  $('image-loading').hidden=true;$('scene').dataset.playbackActive='true';$('scene').dataset.motionActive='false';
  $('explorer').dataset.lastImageLoad=JSON.stringify({ms:Math.round(performance.now()-started),cached:tiles.every(t=>t.cached),files:keys.length});
  paintSweep(sweep.start);
 }catch(error){console.error('[SonoBridge] scan',error);stopScan();setStatus('The scan could not be loaded. Please try again.');}
 finally{requestPins.delete(token);trimCache();}
});
new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;if(inView)dirty=true;else stopScan();},{rootMargin:'100px'}).observe($('explorer'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopScan();else dirty=true;});
document.addEventListener('sonobridge:pause',()=>stopScan());
requestAnimationFrame(tick);

async function init(){
 try{
  manifest=await getManifest(activeOrgan);configureDataset();
  new ResizeObserver(resizeImage).observe(document.querySelector('.image-stage'));
  setupScene().catch(error=>{console.error('[SonoBridge] 3D initialization',error);$('scene-loading').innerHTML='<span>3D is unavailable on this device.<br>Ultrasound controls remain active.</span>';$('camera-reset').disabled=true;$('camera-overview').disabled=true;document.querySelectorAll('[data-organ]').forEach(b=>b.disabled=false);sceneSettled=true;prefetch(readState());});
  await requestState(readState(),false);if(!current)throw Error('Initial ultrasound unavailable');
  inputs.forEach(input=>input.disabled=false);document.querySelectorAll('[data-view]').forEach(b=>b.disabled=false);$('guidance-toggle').disabled=false;$('auto-scan').disabled=false;$('reset-demo').disabled=false;
  $('explorer').setAttribute('aria-busy','false');$('explorer').dataset.ready='true';$('explorer').dataset.controlsReadyMs=String(Math.round(performance.now()));
 }catch(error){console.error('[SonoBridge] initialization',error);setStatus('The demo could not be loaded. Please reload to retry.');$('image-loading').hidden=true;}
}
init();
