import {createEnvironment} from './environment.js?v=6';
let THREE, OrbitControls, GLTFLoader, RoomEnvironment, MeshoptDecoder;
const $ = id => document.getElementById(id);
const root = new URL('../demo/', import.meta.url);
const datasets={liver:{manifest:'manifest.json',imageRoot:'',anatomy:'liver.compact.glb',label:'Liver',posture:'supine'},kidney:{manifest:'kidney/manifest.json',imageRoot:'kidney/',anatomy:'kidney/anatomy.compact.glb',label:'Kidney',posture:'prone'}};
let activeOrgan='liver',datasetGeneration=0,switching=false,wideView=false,environment,anatomyAsset;
const manifests=new Map(),anatomies=new Map();
const inputs = ['position','rotation','shadow','detail'].map($);
const canvas = $('us-canvas'), ctx = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let manifest, current, previous, transition, desired, generation = 0;
let displayMode='output', split=.5, showGuidance=false, scanning=false, scanDirection=1, scanTimer;
let renderer, scene, camera, orbit, asset, fan, fanGroup, robotNodes={}, joints, baseMatrix, initialTarget;
let liveQ, dirty=true, sceneReady=false, inView=true, lastPaint=0, lastTick=0, measurements=[], anatomyCenter, cameraTransition;
const cache=new Map(), overlays=new Map();
const imageStage=$('image-wrap');
const setStatus = text => { $('demo-status').textContent=text; };
const signed = (v,unit) => `${v>0?'+':v<0?'−':''}${Math.abs(v)}${unit}`;
const same = (a,b) => ['position','rotation','shadow','detail'].every(k=>a[k]===b[k]);
function readState(){ return Object.fromEntries(inputs.map(i=>[i.id,Number(i.value)])); }
function paintValues(){
 const s=readState();
 if(manifest){
  $('position-value').textContent=signed(manifest.positions[s.position],' mm');
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
 const keep=new Set([...neededKeys,...(current?.keys||[]),...(previous?.keys||[])]);
 const available=[...cache].filter(([key,r])=>!keep.has(key)&&r.bitmap).sort((a,b)=>a[1].used-b[1].used);
 while(cache.size>64 && available.length){const [key,r]=available.shift();r.bitmap.close();cache.delete(key);}
 while(overlays.size>16)overlays.delete(overlays.keys().next().value);
 $('explorer').dataset.imageCache=JSON.stringify({decoded:[...cache.values()].filter(r=>r.bitmap).length,pending:[...cache.values()].filter(r=>!r.bitmap).length});
}
async function loadImage(key,priority='high'){
 if(cache.has(key)){const r=cache.get(key);r.used=performance.now();return r.promise;}
 const record={used:performance.now(),controller:new AbortController()};
 const [organ,...parts]=key.split('/');
 record.promise=fetch(new URL(`${datasets[organ].imageRoot}frames/${parts.join('/')}.webp`,root),{signal:record.controller.signal,priority})
  .then(r=>{if(!r.ok)throw Error(`Image ${key} unavailable`);return r.blob();})
  .then(createImageBitmap).then(bitmap=>{record.bitmap=bitmap;trimCache();return bitmap;})
  .catch(error=>{if(cache.get(key)===record)cache.delete(key);throw error;});
 cache.set(key,record);return record.promise;
}
function prefetch(state){
 clearTimeout(prefetchTimer);
 if(!sceneSettled||navigator.connection?.saveData||document.hidden||!inView)return;
 const token=generation;
 prefetchTimer=setTimeout(async()=>{
  const candidates=[];
  for(const [key,delta] of [['position',scanDirection],['position',-scanDirection],['rotation',1],['rotation',-1],['shadow',-1],['detail',-1],['shadow',1],['detail',1]]){
   const next={...state,[key]:state[key]+delta};
   if(next[key]<0||next[key]>Number($(key).max))continue;
   candidates.push(imageKey(next));
   if(displayMode!=='output'&&(key==='position'||key==='rotation'))candidates.push(keyFor(poseOf(next).index,displayMode));
  }
  // One small speculative request at a time; foreground interaction always wins.
  for(const key of [...new Set(candidates)]){
   if(token!==generation||document.hidden||!inView)return;
   try{await loadImage(key,'low');trimCache();}catch{}
  }
 },scanning?20:180);
}
async function requestState(state,animate=true){
 desired={...state};paintValues();clearTimeout(prefetchTimer);
 const token=++generation,started=performance.now(),pose=poseOf(state);
 const keys=[imageKey(state)];
 if(displayMode!=='output')keys.push(keyFor(pose.index,displayMode));
 if(showGuidance)keys.push(keyFor(pose.index,`guidance-${state.shadow}`));
 neededKeys=new Set(keys);
 for(const [key,r] of cache)if(!r.bitmap&&!neededKeys.has(key)){r.controller.abort();cache.delete(key);}
 const cached=keys.every(key=>cache.get(key)?.bitmap);
 let loadingTimer=setTimeout(()=>{if(token===generation)$('image-loading').hidden=false;},120);
 try{
  const images=await Promise.all(keys.map(key=>loadImage(key)));
  clearTimeout(loadingTimer);if(token!==generation)return;
  const changed=current&&!same(current.state,state);
  if(changed)previous={...current,q:liveQ?[...liveQ]:current.pose.q};else previous=null;
  current={organ:activeOrgan,state:{...state},pose,bitmap:images[0],reference:displayMode==='output'?null:images[1],referenceMode:displayMode,
   guidanceBitmap:showGuidance?images.at(-1):null,keys};
  transition=previous&&animate&&!reducedMotion?{start:performance.now(),duration:scanning?180:150}:null;
  if(!transition){previous=null;liveQ=[...pose.q];applyPose(liveQ);}
  $('image-loading').hidden=true;
  $('explorer').dataset.pose=String(pose.index);$('explorer').dataset.state=JSON.stringify(state);
  $('explorer').dataset.lastImageLoad=JSON.stringify({ms:Math.round(performance.now()-started),cached,files:keys.length});
  if(!$('explorer').dataset.imageReadyMs)$('explorer').dataset.imageReadyMs=String(Math.round(performance.now()));
  $('image-state').textContent=`${datasets[activeOrgan].label} · Case ${manifest.case_id}`;
  setStatus('Drag to orbit · Scroll to zoom');
  dirty=true;drawUltrasound(transition?0:1);trimCache();prefetch(state);
 }catch(error){
  clearTimeout(loadingTimer);if(token!==generation||error.name==='AbortError')return;
  console.error('[SonoBridge]',error);stopScan();$('image-loading').hidden=true;
  if(current){for(const i of inputs)i.value=current.state[i.id];desired={...current.state};paintValues();}
  setStatus('This view could not be loaded. Select another position or reset to retry.');
 }
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
function tile(bitmap,alpha=1){if(!bitmap)return;ctx.globalAlpha=alpha;ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);ctx.globalAlpha=1;}
function guidance(record){
 if(!record.guidanceBitmap)return null;
 const key=`${record.organ}:${record.pose.index}:${record.state.shadow}`;
 if(overlays.has(key))return overlays.get(key);
 const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d',{willReadFrequently:true});
 x.drawImage(record.guidanceBitmap,0,0);
 const pixels=x.getImageData(0,0,256,256);
 for(let i=0;i<pixels.data.length;i+=4){const support=pixels.data[i],edge=pixels.data[i+1];pixels.data[i]=edge?91:245;pixels.data[i+1]=edge?180:189;pixels.data[i+2]=edge?218:76;pixels.data[i+3]=edge?225:Math.round(support*.7);}
 x.putImageData(pixels,0,0);overlays.set(key,c);return c;
}
function drawRecord(record,alpha=1){
 if(!record)return;
 const comparing=displayMode!=='output'&&record.reference&&record.referenceMode===displayMode;
 if(comparing){
  ctx.save();ctx.beginPath();ctx.rect(0,0,canvas.width*split,canvas.height);ctx.clip();tile(record.reference,alpha);ctx.restore();
  ctx.save();ctx.beginPath();ctx.rect(canvas.width*split,0,canvas.width,canvas.height);ctx.clip();tile(record.bitmap,alpha);ctx.restore();
 }else tile(record.bitmap,alpha);
 if(showGuidance){const overlay=guidance(record);if(overlay){ctx.save();if(comparing){ctx.beginPath();ctx.rect(canvas.width*split,0,canvas.width,canvas.height);ctx.clip();}tile(overlay,alpha);ctx.restore();}}
}
function drawUltrasound(u=1){
 ctx.clearRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.save();ctx.clip(fanPath(canvas.width,canvas.height));
 if(previous&&u<1){drawRecord(previous);drawRecord(current,u);}else drawRecord(current);
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
 dirty=true;
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
 if(animate===true&&!reducedMotion)cameraTransition={start:performance.now(),from:camera.position.clone(),to:position,targetFrom:orbit.target.clone(),targetTo:target.clone()};
 else{cameraTransition=null;orbit.target.copy(target);camera.position.copy(position);orbit.update();}
 $('camera-overview').textContent=wideView?'Focus scan':'Full setup';$('camera-overview').setAttribute('aria-pressed',String(wideView));dirty=true;
}
async function geometryBytes(path){
 const compressed=typeof DecompressionStream!=='undefined';
 const response=await fetch(new URL(path+(compressed?'.gz':''),root));
 if(!response.ok)throw Error('3D asset unavailable');
 return compressed?new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer():response.arrayBuffer();
}
function getManifest(organ){
 if(!manifests.has(organ))manifests.set(organ,fetch(new URL(datasets[organ].manifest,root)).then(r=>{if(!r.ok)throw Error('Acquisition data unavailable');return r.json();}).catch(e=>{manifests.delete(organ);throw e;}));
 return manifests.get(organ);
}
async function getAnatomy(organ){
 if(!anatomies.has(organ))anatomies.set(organ,geometryBytes(datasets[organ].anatomy).then(bytes=>new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes,root.href)).then(g=>{
  const materials={Liver:[0xad493c,organ==='liver'?1:.10],Kidneys:[0x9b6152,organ==='kidney'?1:.28],Vessels:[0xb85c61,.20],Bones:[0xc9c4b6,.09],Skin:[0xb4bebc,.018],Spleen:[0x967d9a,.06],Gallbladder:[0x8c9d6b,.08],Pancreas:[0xc1ad8a,.06]};
  g.scene.traverse(o=>{if(!o.isMesh)return;const name=o.name.replace('anatomy_',''),[color,opacity]=materials[name]||[0xb29a79,.15];o.material=new THREE.MeshStandardMaterial({color,roughness:.55,metalness:0,envMapIntensity:.45,transparent:opacity<1,opacity,depthWrite:opacity>=1,side:THREE.FrontSide});o.castShadow=opacity===1;o.receiveShadow=opacity===1;o.renderOrder=name==='Skin'?8:2;});return g.scene;
 }).catch(e=>{anatomies.delete(organ);throw e;}));
 return anatomies.get(organ);
}
function attachAnatomy(model){
 if(anatomyAsset)asset.remove(anatomyAsset);anatomyAsset=model;asset.add(model);model.updateMatrixWorld(true);
 const skin=model.getObjectByName('anatomy_Skin'),target=model.getObjectByName(activeOrgan==='liver'?'anatomy_Liver':'anatomy_Kidneys');
 anatomyCenter=new THREE.Box3().setFromObject(target).getCenter(new THREE.Vector3());
 environment.alignPatient(new THREE.Box3().setFromObject(skin),datasets[activeOrgan].posture);environment.setPatientVisible($('patient-toggle').checked);
 $('scene').dataset.patientAlignment=JSON.stringify(environment.group.userData.patientAlignment);
 makeFan();applyPose(liveQ||poseOf(manifest.defaults).q);resetCamera();dirty=true;
}
async function setupScene(){
 const runtimePromise=import('../vendor/scene-runtime.js?v=4');
 const robotPromise=geometryBytes('robot.compact.glb');
 const [runtime,robotBytes]=await Promise.all([runtimePromise,robotPromise]);
 THREE=runtime;({OrbitControls,GLTFLoader,RoomEnvironment,MeshoptDecoder}=runtime);
 const container=$('scene');renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.98;
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;container.appendChild(renderer.domElement);
 scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(35,1,.02,20);camera.up.set(0,0,1);
 orbit=new OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;orbit.dampingFactor=.09;orbit.minDistance=.45;orbit.maxDistance=5;orbit.maxPolarAngle=Math.PI*.8;orbit.addEventListener('change',()=>dirty=true);orbit.addEventListener('start',()=>cameraTransition=null);
 const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();scene.environment=pmrem.fromScene(room,.04).texture;room.dispose();pmrem.dispose();
 const hemi=new THREE.HemisphereLight(0xfffaf4,0xb2bab9,1.6);hemi.position.set(0,0,3);scene.add(hemi);
 const sun=new THREE.DirectionalLight(0xfffaf3,2);sun.position.set(-1,-1.5,3);sun.target.position.set(0,.2,.55);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-1.5,right:1.5,top:1.7,bottom:-1.7,near:.1,far:6});sun.shadow.bias=-.0002;sun.shadow.normalBias=.008;sun.shadow.radius=3;scene.add(sun,sun.target);
 const fill=new THREE.DirectionalLight(0xdce9ef,.8);fill.position.set(1,1,2);scene.add(fill);
 asset=new THREE.Group();scene.add(asset);const gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(robotBytes,root.href);asset.add(gltf.scene);
 gltf.scene.traverse(o=>{if(o.name==='web_base'||/^web_fr3_link[0-8]$/.test(o.name))robotNodes[o.name.slice(4)]=o;if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
 environment=createEnvironment(THREE,scene);
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
 $('case-label').textContent=`${datasets[activeOrgan].label} · Case ${manifest.case_id}`;
 $('scan-specs').textContent=`${manifest.frequency_mhz.toFixed(1)} MHz · ${manifest.depth_mm} mm depth`;
 $('scene').setAttribute('aria-label',`Interactive ${datasets[activeOrgan].label.toLowerCase()} anatomy and robotic probe, patient ${datasets[activeOrgan].posture}${activeOrgan==='kidney'?' with back facing up':''}`);
 $('scene-context').textContent=activeOrgan==='liver'?'Liver · Supine acquisition':'Kidney · Prone · Back facing up';
 imageStage.style.aspectRatio=String(manifest.aspect);resizeImage();paintValues();
 $('explorer').dataset.organ=activeOrgan;$('explorer').dataset.case=manifest.case_id;
 document.querySelectorAll('[data-organ]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.organ===activeOrgan));b.classList.remove('is-loading');});
}
function resizeImage(){
 if(!manifest)return;const box=document.querySelector('.image-stage'),style=getComputedStyle(box);
 const width=box.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),height=box.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
 const w=Math.min(width,height*manifest.aspect,$('explorer').classList.contains('is-expanded')?650:500);imageStage.style.width=`${w}px`;imageStage.style.height=`${w/manifest.aspect}px`;
}
async function switchOrgan(organ){
 $('explorer').dataset.switchStartMs=String(Math.round(performance.now()));
 const token=++datasetGeneration;stopScan();clearTimeout(prefetchTimer);generation++;switching=true;
 inputs.forEach(i=>i.disabled=true);document.querySelectorAll('[data-view]').forEach(b=>b.disabled=true);$('guidance-toggle').disabled=true;$('reset-demo').disabled=true;$('auto-scan').disabled=true;
 document.querySelectorAll('[data-organ]').forEach(b=>b.classList.toggle('is-loading',b.dataset.organ===organ));
 setStatus(`Loading ${datasets[organ].label.toLowerCase()} acquisition…`);
 try{
  const next=await getManifest(organ);const index=next.defaults.position*next.rotations.length+next.defaults.rotation;
  const keys=[keyFor(index,`us-${next.defaults.shadow}-${next.defaults.detail}`,organ)];
  if(displayMode!=='output')keys.push(keyFor(index,displayMode,organ));if(showGuidance)keys.push(keyFor(index,`guidance-${next.defaults.shadow}`,organ));
  const modelPromise=sceneReady?getAnatomy(organ):Promise.resolve(null);
  const [model]=await Promise.all([modelPromise,...keys.map(key=>loadImage(key))]);if(token!==datasetGeneration)return;
  activeOrgan=organ;manifest=next;previous=null;current=null;transition=null;liveQ=null;wideView=false;
  configureDataset();if(sceneReady){baseMatrix=matrix(next.kinematics.base);joints=next.kinematics.joints.map(j=>({...j,T:matrix(j.origin),axis:new THREE.Vector3(...j.axis)}));attachAnatomy(model);}
  await requestState(next.defaults,false);$('explorer').dataset.switchReadyMs=String(Math.round(performance.now()));
 }catch(error){if(token!==datasetGeneration)return;console.error('[SonoBridge] organ switch',error);setStatus('This acquisition could not be loaded. Select the organ again to retry.');}
 finally{if(token===datasetGeneration){switching=false;inputs.forEach(i=>i.disabled=false);paintValues();document.querySelectorAll('[data-view]').forEach(b=>b.disabled=false);$('guidance-toggle').disabled=false;$('reset-demo').disabled=false;$('auto-scan').disabled=false;document.querySelectorAll('[data-organ]').forEach(b=>b.classList.remove('is-loading'));}}
}
function tick(now){
 requestAnimationFrame(tick);if(!inView)return;
 if(cameraTransition){const t=cameraTransition,u=Math.min(1,(now-t.start)/450),s=u*u*(3-2*u);camera.position.lerpVectors(t.from,t.to,s);orbit.target.lerpVectors(t.targetFrom,t.targetTo,s);dirty=true;if(u===1)cameraTransition=null;}
 let u=1;
 if(transition&&current){u=Math.min(1,(now-transition.start)/transition.duration);liveQ=current.pose.q.map((q,i)=>previous.q[i]+(q-previous.q[i])*u);applyPose(liveQ);drawUltrasound(u);dirty=true;if(u===1){transition=null;previous=null;trimCache();}}
 orbit?.update();
 if(renderer&&sceneReady&&dirty){renderer.render(scene,camera);dirty=false;
  if(lastPaint&&now-lastPaint<250){measurements.push(now-lastPaint);if(measurements.length>120)measurements.shift();}
  lastPaint=now;if(now-lastTick>1000){lastTick=now;$('scene').dataset.renderStats=JSON.stringify({fps:measurements.length?Math.round(1000/(measurements.reduce((a,b)=>a+b)/measurements.length)):0,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,cachedImages:cache.size});}
 }
}
function stopScan(){scanning=false;clearTimeout(scanTimer);$('auto-scan').innerHTML='<span class="play-icon">▷</span> Auto scan';$('auto-scan').setAttribute('aria-pressed','false');}
async function scanStep(){
 if(!scanning||document.hidden)return stopScan();
 const state=readState();let next=state.position+scanDirection;
 if(next<0||next>=manifest.positions.length){scanDirection*=-1;next=state.position+scanDirection;}
 $('position').value=next;await requestState(readState());if(scanning)scanTimer=setTimeout(scanStep,180);
}
inputs.forEach(input=>input.addEventListener('input',()=>{stopScan();requestState(readState());}));
$('guidance-toggle').addEventListener('change',e=>{showGuidance=e.target.checked;requestState(readState(),false);});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{
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
$('auto-scan').addEventListener('click',()=>{if(scanning)return stopScan();scanning=true;$('auto-scan').innerHTML='<span class="play-icon">Ⅱ</span> Pause scan';$('auto-scan').setAttribute('aria-pressed','true');scanStep();});
new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;if(inView)dirty=true;else stopScan();},{rootMargin:'100px'}).observe($('explorer'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopScan();else dirty=true;});
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
