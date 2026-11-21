import {createEnvironment} from './environment.js?v=10';
import {createJointCurve,sweepPhase,sweepPosition} from './motion.js?v=1';
import {labelPalette,labelPoseMasks} from './label-legend.js?v=1';
import {cleanVisibilityContours} from './guidance.js?v=2';
let THREE, OrbitControls, GLTFLoader, RoomEnvironment, MeshoptDecoder;
const $ = id => document.getElementById(id);
const root = new URL('../demo/', import.meta.url);
const datasets = {
 liver: {manifest:'liver/manifest-v4.json', imageRoot:'liver/', label:'Liver', posture:'supine', structure:'vessels', note:'Liver ultrasound is lightly brightened for display.'},
 kidney: {manifest:'kidney/manifest-v4.json', imageRoot:'kidney/', label:'Kidney', posture:'prone', structure:'medulla', note:'Kidney ultrasound uses local texture blending to soften the gray rim.'}
};
let activeOrgan='liver',datasetGeneration=0,switching=false,wideView=false,environment,anatomyAsset;
const manifests=new Map(),anatomies=new Map();
const inputs = ['position','rotation','shadow','detail'].map($);
const organButtons = [...document.querySelectorAll('.organ-picker button')];
const canvas = $('us-canvas'), ctx = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let manifest, current, transition, generation = 0, sceneUnavailable = false;
let displayMode='output', showGuidance=false, scanning=false, scanDirection=1, sweep=null;
let renderer, scene, camera, orbit, asset, fan, fanGroup, robotNodes={}, joints, linkTransforms, jointRotation, faceOffset, fanManifest;
let liveQ, dirty=true, sceneReady=false, inView=true, lastPaint=0, lastTick=0, measurements=[], cameraTransition;
let probeMotion,wheelZoom,lastFrame=0,lastShadowUpdate=0,shadowDirty=true,framePending=false;
let fanClip, imageModeKey='',loadingTimer;
const stillPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
let motionQuality = 1, slowFrames = 0;
const blendFrom=document.createElement('canvas'),blendCtx=blendFrom.getContext('2d');
blendFrom.width=canvas.width;blendFrom.height=canvas.height;
const cache=new Map(), overlays=new Map(),requestPins=new Map(),displayImages=new Map();
// One fixed display curve for liver US: lift tissue midtones while anchoring
// black and gently tapering the lift below 24/255. Source image data stay raw.
const liverDisplayLut=Uint8ClampedArray.from({length:256},(_,v)=>{
 const t=Math.min(1,v/24),weight=t*t*(3-2*t);
 return Math.round(v+(255*Math.pow(v/255,.86)-v)*weight);
});
const imageStage=$('image-wrap');
const compareRange=$('compare-range'), compareDivider=$('compare-divider');
const compactLayout=matchMedia('(max-width:720px)');
const labelLegend=$('label-legend'),legendItems=new Map();
let legendLayoutKey='',legendMask=-1;
for(const [id,name,color] of labelPalette){
 const item=document.createElement('span'),swatch=document.createElement('i');item.className='label-legend-item';item.setAttribute('role','listitem');item.dataset.label=String(id);
 swatch.style.backgroundColor=color;swatch.setAttribute('aria-hidden','true');item.append(swatch,document.createTextNode(name));labelLegend.append(item);legendItems.set(id,item);
}
function syncLabelLegend(record){
 const enabled=record?.referenceMode==='label';labelLegend.hidden=!enabled;
 if(!enabled)return;
 const poses=labelPoseMasks[record.organ],layoutKey=`${record.organ}:${labelLegend.clientWidth}`;
 if(layoutKey!==legendLayoutKey){
  // Reserve the case's full palette height once; only its present labels are
  // shown, without changing the image size as an automatic sweep advances.
  const all=poses.reduce((mask,value)=>mask|value,0);
  for(const [id,item] of legendItems)item.hidden=!(all&(1<<id));
  labelLegend.style.height='auto';labelLegend.style.height=`${labelLegend.getBoundingClientRect().height}px`;legendLayoutKey=layoutKey;legendMask=-1;
 }
 const mask=poses[record.pose.index];
 if(mask!==legendMask){for(const [id,item] of legendItems)item.hidden=!(mask&(1<<id));legendMask=mask;}
}
const setStatus = text => { if ($('demo-status').textContent !== text) $('demo-status').textContent=text; };
const orbitHint = () => matchMedia('(pointer:coarse)').matches ? 'Swipe sideways to orbit the robot.' : 'Drag to orbit the robot. Scroll to zoom.';
const signed = (v,unit) => `${v>0?'+':v<0?'−':''}${Math.abs(v)}${unit}`;
const same = (a,b) => ['position','rotation','shadow','detail'].every(k=>a[k]===b[k]);
function readState(){ return Object.fromEntries(inputs.map(i=>[i.id,Math.round(Number(i.value))])); }
function paintValues(){
 const s=readState();
 if(manifest){
  $('position-value').textContent=signed(Math.round(manifest.positions[s.position]*10)/10,' mm');
  $('rotation-value').textContent=signed(manifest.rotations[s.rotation],'°');
  updateShadowControl(poseOf(s));
  $('detail-value').textContent=manifest.details[s.detail].toFixed(2);
 }
 inputs.forEach(i=>{i.style.setProperty('--fill',`${100*(i.value-i.min)/(i.max-i.min)}%`);i.setAttribute('aria-valuetext',$(i.id+'-value').textContent);});
}
function updateShadowControl(pose) {
 const slider = $('shadow'), available = pose.shadow_control !== false, value = manifest.shadows[Number(slider.value)];
 slider.disabled = switching || !available;
 slider.title = available ? '' : 'Move the probe to a view with an adjustable shadow.';
 $('shadow-value').textContent = available ? signed(value,'%') : 'Not active';
 slider.setAttribute('aria-valuetext',$('shadow-value').textContent);
}
function poseOf(state){return manifest.poses[state.position*manifest.rotations.length+state.rotation];}
function trimCache() {
 const keep = new Set(current?.cacheKeys || []);
 for (const pins of requestPins.values()) for (const key of pins) keep.add(key);
 const decoded = [...cache].filter(([, entry]) => entry.bitmap);
 let bytes = decoded.reduce((total, [, entry]) => total + entry.bitmap.width * entry.bitmap.height * 4, 0);
 const budget = (compactLayout.matches ? 36 : 64) * 1024 * 1024;
 for (const [key, entry] of decoded.sort((a,b) => a[1].used - b[1].used)) {
  if (bytes <= budget) break;
  if (keep.has(key)) continue;
  bytes -= entry.bitmap.width * entry.bitmap.height * 4;
  entry.bitmap.close();
  cache.delete(key);
 }
}

function loadTile(organ, data, pose, name, forceTrack, pins, priority = 'high') {
 const folder = datasets[organ].imageRoot;
 const track = folder + (data.tracks || 'tracks') + '/' + name + '-r' + String(pose.j).padStart(2, '0') + '.webp';
 const defaults = data.defaults;
 const preview = !forceTrack && !cache.get(track)?.bitmap && pose.i === defaults.position && pose.j === defaults.rotation
  && name === 'us-' + defaults.shadow + '-' + defaults.detail;
 const path = preview ? folder + data.preview : track;
 pins?.add(path);
 let entry = cache.get(path);
 const cached = Boolean(entry?.bitmap);
 if (!entry) {
  const controller = new AbortController();
  entry = {controller};
  entry.promise = fetch(new URL(path, root), {signal:controller.signal, priority})
   .then(response => {
    if (!response.ok) throw Error('Image unavailable: ' + path);
    return response.blob();
   })
   .then(blob => createImageBitmap(blob))
   .then(bitmap => {
    if (controller.signal.aborted) {
     bitmap.close();
     throw new DOMException('Superseded view', 'AbortError');
    }
    entry.bitmap = bitmap;
    return bitmap;
   })
   .catch(error => {
    if (cache.get(path) === entry) cache.delete(path);
    throw error;
   });
  cache.set(path, entry);
 }
 entry.used = performance.now();
 return entry.promise.then(image => ({
  image, sx:preview ? 0 : pose.i * data.tile_size, sy:0, sw:data.tile_size, sh:data.tile_size, cacheKey:path, cached
 }));
}

function beginRequest() {
 const token = ++generation;
 requestPins.set(token, new Set());
 clearTimeout(loadingTimer);
 $('image-loading').hidden = Boolean(current);
 $('image-loading').classList.toggle('has-image', Boolean(current));
 $('image-loading').lastElementChild.textContent = current ? 'Updating view…' : 'Loading ultrasound';
 if (current) loadingTimer = setTimeout(() => { $('image-loading').hidden = false; }, 300);
 return token;
}

function finishRequest(token) {
 requestPins.delete(token);
 if (token === generation) {
  clearTimeout(loadingTimer);
  $('image-loading').hidden = true;
 }
 trimCache();
}

function loadViewTiles(organ, data, state, mode, guided, token, forceTrack = false) {
 const pose = data.poses[state.position * data.rotations.length + state.rotation];
 const pins = requestPins.get(token);
 const names = ['us-' + state.shadow + '-' + state.detail];
 if (mode !== 'output') names.push(mode);
 if (guided) names.push('guidance-' + state.shadow);
 const loads = names.map(name => loadTile(organ, data, pose, name, forceTrack, pins));
 // Retain a shared track across rapid position changes. Obsolete downloads for
 // unrelated rotations or appearance settings should release the connection.
 cancelUnusedTiles(pins);
 return Promise.all(loads);
}

function cancelUnusedTiles(pins) {
 for (const [path, entry] of cache) {
  if (!entry.bitmap && !pins.has(path)) {
   entry.controller.abort();
   cache.delete(path);
  }
 }
}

function warmScan() {
 if (!manifest || switching || scanning || !current || navigator.connection?.saveData) return;
 const state = readState();
 loadTile(activeOrgan, manifest, poseOf(state), 'us-' + state.shadow + '-' + state.detail, true, null, 'low')
  .then(trimCache).catch(() => {});
}

function frameRecord(state, mode, guided, tiles) {
 return {
  organ:activeOrgan, state:{...state}, pose:poseOf(state),
  bitmap:tiles[0], reference:mode === 'output' ? null : tiles[1], referenceMode:mode,
  guidanceBitmap:guided ? tiles.at(-1) : null, cacheKeys:tiles.map(tile => tile.cacheKey)
 };
}

function moveProbe(state, animate, start) {
 const q = poseOf(state).q;
 if (!liveQ || !animate || reducedMotion) {
  probeMotion = null;
  liveQ = [...q];
  applyPose(liveQ);
  return;
 }
 if (q.every((value,i) => Math.abs(value - (probeMotion?.to[i] ?? liveQ[i])) < 1e-7)) return;
 probeMotion = {from:[...liveQ], to:q, start, duration:180};
 $('scene').dataset.motionActive = 'true';
 scheduleFrame();
}

function showFrame(record, animate) {
 const changed = current && !same(current.state, record.state);
 const fade = Boolean(changed && animate && !reducedMotion && record.referenceMode !== 'label' && !record.guidanceBitmap);
 const start = performance.now();
 if (fade) {
  blendCtx.clearRect(0, 0, blendFrom.width, blendFrom.height);
  blendCtx.drawImage(canvas, 0, 0);
 }
 current = record;
 transition = fade ? {start, duration:180} : null;
 moveProbe(record.state, fade, start);
 updateImageMode(record);
 $('explorer').dataset.pose = String(record.pose.index);
 $('explorer').dataset.state = JSON.stringify(record.state);
 drawUltrasound(fade ? 0 : 1);
 scheduleFrame();
}

async function requestState(state, animate = true) {
 const token = beginRequest(), started = performance.now();
 const mode = displayMode, guided = showGuidance;
 paintValues();
 try {
  const tiles = await loadViewTiles(activeOrgan, manifest, state, mode, guided, token);
  if (token !== generation) return;
  showFrame(frameRecord(state, mode, guided, tiles), animate);
  $('explorer').dataset.lastImageLoad = JSON.stringify({ms:Math.round(performance.now()-started), cached:tiles.every(t => t.cached), files:tiles.length});
  if (!$('explorer').dataset.imageReadyMs) $('explorer').dataset.imageReadyMs = String(Math.round(performance.now()));
  setStatus(sceneUnavailable ? '' : orbitHint());
 } catch (error) {
  if (token !== generation || error.name === 'AbortError') return;
  console.error('[SonoBridge] ultrasound', error);
  restoreControls();
  setStatus('This view could not be loaded. Select it again to retry.');
 } finally {
  finishRequest(token);
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
function tile(bitmap,alpha=1){if(!bitmap)return;ctx.globalAlpha=alpha;if(bitmap.image)ctx.drawImage(bitmap.image,bitmap.sx,bitmap.sy,bitmap.sw,bitmap.sh,0,0,canvas.width,canvas.height);else ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);ctx.globalAlpha=1;}
function ultrasoundDisplay(record){
 if(record.organ!=='liver')return record.bitmap;
 const key=`${record.pose.index}:${record.state.shadow}:${record.state.detail}`;
 if(displayImages.has(key))return displayImages.get(key);
 const c=document.createElement('canvas');c.width=c.height=256;
 const x=c.getContext('2d',{willReadFrequently:true}),t=record.bitmap;
 x.drawImage(t.image,t.sx,t.sy,t.sw,t.sh,0,0,256,256);
 const pixels=x.getImageData(0,0,256,256),data=pixels.data;
 for(let p=0;p<data.length;p+=4){data[p]=liverDisplayLut[data[p]];data[p+1]=liverDisplayLut[data[p+1]];data[p+2]=liverDisplayLut[data[p+2]];}
 x.putImageData(pixels,0,0);displayImages.set(key,c);
 while(displayImages.size>16)displayImages.delete(displayImages.keys().next().value);
 return c;
}
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
function syncComparison() {
 if (compareRange.hidden) return;
 const percent = compareRange.valueAsNumber;
 const [source, output] = $('compare-labels').children;
 const width = imageStage.clientWidth;
 const left = width * percent / 100;
 const sourceFits = left >= source.offsetWidth + 8;
 const outputFits = width - left >= output.offsetWidth + 8;
 source.style.visibility = sourceFits ? '' : 'hidden';
 output.style.visibility = outputFits ? '' : 'hidden';
 imageStage.style.setProperty('--compare-position', percent + '%');
 compareRange.setAttribute('aria-valuetext', `${source.textContent} ${percent}%, SonoBridge ${100 - percent}%`);
}

function updateImageMode(record) {
 const comparing = record.referenceMode !== 'output';
 const label = record.referenceMode === 'label' ? 'Label map' : 'CT';
 const key = [record.organ, record.referenceMode, Boolean(record.guidanceBitmap)].join('/');
 if (imageModeKey !== key) {
  imageModeKey = key;
  for (const id of ['compare-range', 'compare-divider', 'compare-labels']) $(id).hidden = !comparing;
  $('compare-source').textContent = label;
  syncComparison();
  $('guidance-key').hidden = !record.guidanceBitmap;
  const structure = datasets[record.organ].structure;
  $('structure-label').textContent = 'Visible ' + structure;
  $('overlay-label').textContent = 'Visibility & ' + structure;
  canvas.setAttribute('aria-label', comparing ? label + ' and SonoBridge ultrasound comparison' : 'SonoBridge ultrasound output');
 }
 syncLabelLegend(record);
}

function drawSeries(record, getTile, alpha) {
 if (record.blend) {
  const {a,b,u} = record.blend;
  tile(getTile(a), alpha);
  tile(getTile(b), alpha * u);
 } else tile(getTile(record), alpha);
}

function drawRecord(record, alpha) {
 const comparing = Boolean(record.reference);
 const width = canvas.width, height = canvas.height;
 const divider = comparing ? width * compareRange.valueAsNumber / 100 : 0;
 if (comparing) {
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, divider, height); ctx.clip();
  if (record.referenceMode === 'label') {
   ctx.imageSmoothingEnabled = false;
   tile(record.reference, alpha);
  } else drawSeries(record, frame => frame.reference, alpha);
  ctx.restore();
 }
 ctx.save();
 if (comparing) {
  ctx.beginPath(); ctx.rect(divider, 0, width - divider, height); ctx.clip();
 }
 drawSeries(record, ultrasoundDisplay, alpha);
 // The categorical label colours and contours come from the nearest acquired
 // slice. Cross-fading those layers would create extra colours and double edges.
 if (record.guidanceBitmap) tile(guidance(record), alpha);
 ctx.restore();
}

function drawUltrasound(u = 1) {
 if (!current || !fanClip) return;
 ctx.clearRect(0, 0, canvas.width, canvas.height);
 ctx.imageSmoothingEnabled = true;
 ctx.imageSmoothingQuality = 'high';
 ctx.save();
 ctx.clip(fanClip);
 if (transition && u < 1) ctx.drawImage(blendFrom, 0, 0);
 drawRecord(current, u);
 ctx.restore();
}
function scheduleFrame() {
 if (!framePending && inView && !document.hidden) {
  framePending = true;
  requestAnimationFrame(tick);
 }
}
function invalidate() {
 dirty = true;
 scheduleFrame();
}
function matrix(rows){return new THREE.Matrix4().set(...rows.flat());}
function configureKinematics() {
 const model = manifest.kinematics;
 linkTransforms = {base:matrix(model.base)};
 jointRotation = new THREE.Matrix4();
 faceOffset = new THREE.Matrix4().makeTranslation(...model.face_offset);
 joints = model.joints.map(link => {
  const transform = new THREE.Matrix4();
  linkTransforms[link.child] = transform;
  return {parent:linkTransforms[link.parent], transform, origin:matrix(link.origin), axis:new THREE.Vector3(...link.axis), moving:link.moving};
 });
}
function applyPose(q) {
 if (!sceneReady || !q) return;
 let axis = 0;
 for (const joint of joints) {
  joint.transform.multiplyMatrices(joint.parent, joint.origin);
  if (joint.moving) joint.transform.multiply(jointRotation.makeRotationAxis(joint.axis, q[axis++]));
 }
 for (const name in robotNodes) {
  const node = robotNodes[name];
  node.matrixAutoUpdate = false;
  node.matrix.copy(linkTransforms[name]);
  node.matrixWorldNeedsUpdate = true;
 }
 fanGroup.matrixAutoUpdate = false;
 fanGroup.matrix.multiplyMatrices(linkTransforms.fr3_link8, faceOffset);
 fanGroup.matrixWorldNeedsUpdate = true;
 shadowDirty = true;
 invalidate();
}
function makeFan(){
 if (fanManifest === manifest) return;
 fanManifest = manifest;
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
 $('camera-overview').textContent=wideView?'Focus scan':'Full setup';$('camera-overview').setAttribute('aria-pressed',String(wideView));invalidate();
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
 const skin=model.getObjectByName('anatomy_Skin');
 const abdominalAnchor=new THREE.Box3().setFromObject(model.getObjectByName('anatomy_Kidneys')).getCenter(new THREE.Vector3());
 environment.alignPatient(new THREE.Box3().setFromObject(skin),datasets[activeOrgan].posture,abdominalAnchor);environment.setPatientVisible($('patient-toggle').checked);
 $('scene').dataset.patientAlignment=JSON.stringify(environment.group.userData.patientAlignment);
 makeFan();applyPose(liveQ||poseOf(manifest.defaults).q);resetCamera();invalidate();
}
async function setupScene(){
 const runtimePromise=import('../vendor/scene-runtime.js?v=5');
 const robotPromise=geometryBytes('robot.compact.glb');
 const [runtime,robotBytes,patientBytes]=await Promise.all([runtimePromise,robotPromise,geometryBytes('patient-v2.compact.glb','2')]);
 THREE=runtime;({OrbitControls,GLTFLoader,RoomEnvironment,MeshoptDecoder}=runtime);
 const container=$('scene');renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(stillPixelRatio);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.94;
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;container.appendChild(renderer.domElement);
 scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(35,1,.02,20);camera.up.set(0,0,1);
 orbit=new OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;orbit.dampingFactor=.075;orbit.rotateSpeed=.65;orbit.zoomSpeed=.35;orbit.minDistance=.45;orbit.maxDistance=5;orbit.maxPolarAngle=Math.PI*.8;orbit.addEventListener('change',invalidate);orbit.addEventListener('start',()=>{cameraTransition=null;wheelZoom=null;});
 renderer.domElement.style.touchAction='pan-y';
 // OrbitControls damps rotation but applies wheel distance instantly. Normalize
 // wheel units, bound each impulse, then ease distance in the animation loop.
 renderer.domElement.addEventListener('wheel',event=>{
  event.preventDefault();event.stopImmediatePropagation();cameraTransition=null;
  const unit=event.deltaMode===1?16:event.deltaMode===2?container.clientHeight:1;
  const impulse=Math.max(-80,Math.min(80,event.deltaY*unit));
  const from=wheelZoom?.target??camera.position.distanceTo(orbit.target);
  wheelZoom={target:Math.max(orbit.minDistance,Math.min(orbit.maxDistance,from*Math.exp(impulse*.00045)))};invalidate();
 },{capture:true,passive:false});
 const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();scene.environment=pmrem.fromScene(room,.04).texture;room.dispose();pmrem.dispose();
 const hemi=new THREE.HemisphereLight(0xfffaf4,0xb2bab9,1.4);hemi.position.set(0,0,3);scene.add(hemi);
 const sun=new THREE.DirectionalLight(0xfffaf3,1.65);sun.position.set(-1,-1.5,3);sun.target.position.set(0,.2,.55);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-1.5,right:1.5,top:1.7,bottom:-1.7,near:.1,far:6});sun.shadow.bias=-.0002;sun.shadow.normalBias=.008;sun.shadow.radius=3;scene.add(sun,sun.target);
 const fill=new THREE.DirectionalLight(0xdce9ef,.8);fill.position.set(1,1,2);scene.add(fill);
 asset=new THREE.Group();scene.add(asset);const gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(robotBytes,root.href);asset.add(gltf.scene);
 gltf.scene.traverse(o=>{if(o.name==='web_base'||/^web_fr3_link[0-8]$/.test(o.name))robotNodes[o.name.slice(4)]=o;if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
 const patient=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(patientBytes,root.href);
 environment=createEnvironment(THREE,scene,patient.scene);
 configureKinematics();makeFan();
 sceneReady=true;applyPose(liveQ||poseOf(manifest.defaults).q);resetCamera();
 let previousAspect = 0;
 new ResizeObserver(() => {
  const width = container.clientWidth, height = container.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (!previousAspect || Math.abs(Math.log(camera.aspect / previousAspect)) > .18) resetCamera();
  previousAspect = camera.aspect;
  invalidate();
 }).observe(container);
 $('scene-loading').classList.add('anatomy-progress');
 $('scene-loading').lastElementChild.textContent='Loading anatomy';
 container.dataset.robotReadyMs=String(Math.round(performance.now()));
 const model = await getAnatomy(activeOrgan);
 attachAnatomy(model);
 $('scene-loading').hidden=true;
 container.dataset.ready='true';
 container.dataset.readyMs=String(Math.round(performance.now()));
 organButtons.forEach(button => button.disabled=false);
}
function configureDataset() {
 const data = datasets[activeOrgan];
 const axes = {position:manifest.positions, rotation:manifest.rotations, shadow:manifest.shadows, detail:manifest.details};
 for (const input of inputs) {
  input.max = axes[input.id].length - 1;
  input.value = manifest.defaults[input.id];
 }
 for (const [id, values, unit] of [['position',manifest.positions,' mm'], ['rotation',manifest.rotations,'°'], ['shadow',manifest.shadows,'%']]) {
  $(id+'-min').textContent = signed(values[0], unit);
  $(id+'-max').textContent = signed(values.at(-1), unit);
 }
 $('scan-specs').textContent = manifest.frequency_mhz.toFixed(1) + ' MHz · ' + manifest.depth_mm + ' mm depth';
 $('scene').setAttribute('aria-label', 'Interactive ' + data.label.toLowerCase() + ' anatomy and robotic probe, patient ' + data.posture);
 $('scene-context').textContent = activeOrgan === 'liver' ? 'Liver · Supine' : 'Kidney · Prone (back up)';
 $('display-note').textContent = data.note;
 $('explorer').dataset.organ = activeOrgan;
 $('explorer').dataset.case = manifest.case_id;
 organButtons.forEach(button => {
  button.setAttribute('aria-pressed', String(button.dataset.organ === activeOrgan));
 });
 fanClip = null;
 resizeImage();
 paintValues();
}

function resizeImage() {
 if (!manifest) return;
 const stage = document.querySelector('.image-stage'), style = getComputedStyle(stage);
 const availableWidth = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
 const availableHeight = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
 const limit = $('explorer').classList.contains('is-expanded') ? 720 : 540;
 const width = Math.min(availableWidth, compactLayout.matches ? Infinity : availableHeight * manifest.aspect, limit);
 if (!(width > 0)) return;
 const height = width / manifest.aspect;
 imageStage.style.width = width + 'px';
 imageStage.style.height = height + 'px';
 const scale = Math.min(window.devicePixelRatio || 1, 2);
 const w = Math.round(width * scale), h = Math.round(height * scale);
 if (canvas.width !== w || canvas.height !== h || !fanClip) {
  canvas.width = blendFrom.width = w;
  canvas.height = blendFrom.height = h;
  fanClip = fanPath(w,h);
  transition = null;
  drawUltrasound();
 }
 syncLabelLegend(current);
 syncComparison();
}

function setControlsEnabled(enabled) {
 for (const element of [...inputs, ...document.querySelectorAll('[data-view]'), $('guidance-toggle'), $('auto-scan'), $('reset-demo')]) {
  element.disabled = !enabled;
 }
 if (enabled) paintValues();
}

function markViewButtons() {
 document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === displayMode)));
 $('guidance-toggle').checked = showGuidance;
}

function restoreControls() {
 if (!current) return;
 displayMode = current.referenceMode;
 showGuidance = Boolean(current.guidanceBitmap);
 for (const input of inputs) input.value = current.state[input.id];
 markViewButtons();
 paintValues();
}

async function switchOrgan(organ) {
 if (!switching && organ === activeOrgan) return;
 stopScan();
 const revision = ++datasetGeneration, token = beginRequest();
 const mode = displayMode, guided = showGuidance;
 switching = true;
 setControlsEnabled(false);
 $('explorer').dataset.switchStartMs = String(Math.round(performance.now()));
 $('explorer').setAttribute('aria-busy','true');
 organButtons.forEach(button => button.classList.toggle('is-loading', button.dataset.organ === organ));
 setStatus('Loading the ' + organ + ' demo…');
 try {
  const next = await getManifest(organ);
  if (revision !== datasetGeneration) return;
  const [model,tiles] = await Promise.all([
   sceneReady ? getAnatomy(organ) : null,
   loadViewTiles(organ, next, next.defaults, mode, guided, token)
  ]);
  if (revision !== datasetGeneration) return;
  activeOrgan = organ;
  manifest = next;
  current = null;
  transition = probeMotion = liveQ = null;
  wideView = false;
  scanDirection = 1;
  configureDataset();
  if (model) {
   configureKinematics();
   attachAnatomy(model);
  }
  showFrame(frameRecord(next.defaults, mode, guided, tiles), false);
  $('explorer').dataset.switchReadyMs = String(Math.round(performance.now()));
  setStatus(sceneUnavailable ? '' : orbitHint());
 } catch (error) {
  if (revision !== datasetGeneration || error.name === 'AbortError') return;
  console.error('[SonoBridge] organ switch', error);
  setStatus('The case could not be loaded. Select it again to retry.');
 } finally {
  finishRequest(token);
  if (revision === datasetGeneration) {
   switching = false;
   setControlsEnabled(true);
   $('explorer').setAttribute('aria-busy','false');
   organButtons.forEach(button => button.classList.remove('is-loading'));
  }
 }
}
function tick(now) {
 framePending = false;
 if (!inView || document.hidden) return;
 const dt = Math.min(.05, Math.max(.001, (now-lastFrame)/1000));
 lastFrame = now;
 if (scanning && sweep) paintSweep(now);

 if (cameraTransition) {
  const t = cameraTransition, u = Math.min(1,(now-t.start)/450), weight = u*u*(3-2*u);
  camera.position.lerpVectors(t.from,t.to,weight);
  orbit.target.lerpVectors(t.targetFrom,t.targetTo,weight);
  dirty = true;
  if (u === 1) cameraTransition = null;
 }
 if (wheelZoom && camera) {
  const radius = camera.position.distanceTo(orbit.target);
  const next = radius + (wheelZoom.target-radius)*(1-Math.exp(-dt/.13));
  camera.position.sub(orbit.target).multiplyScalar(next/radius).add(orbit.target);
  dirty = true;
  if (Math.abs(next-wheelZoom.target) < .0001) wheelZoom = null;
  $('scene').dataset.cameraDistance = next.toFixed(5);
 }
 if (probeMotion) {
  const t = probeMotion, u = Math.min(1,(now-t.start)/t.duration), weight = u*u*(3-2*u);
  liveQ = t.to.map((q,i) => t.from[i]+(q-t.from[i])*weight);
  applyPose(liveQ);
  if (u === 1) { probeMotion = null; $('scene').dataset.motionActive='false'; }
 }
 if (transition && current) {
  const u = Math.min(1,(now-transition.start)/transition.duration);
  drawUltrasound(u);
  if (u === 1) transition = null;
 }
 const orbitChanged = orbit?.update();
 if (renderer && sceneReady) {
  const shadowInterval = scanning ? (motionQuality === 1 ? 90 : 300) : 45;
  if (shadowDirty && now-lastShadowUpdate >= shadowInterval) {
   renderer.shadowMap.needsUpdate = true;
   shadowDirty = false; lastShadowUpdate = now; dirty = true;
  }
  if (dirty) {
   renderer.render(scene,camera);
   dirty = false;
   if (lastPaint && now-lastPaint < 250) {
    measurements.push(now-lastPaint);
    if (measurements.length > 120) measurements.shift();
   }
   lastPaint = now;
   if (now-lastTick > 1000) {
    lastTick = now;
    $('scene').dataset.renderStats = JSON.stringify({
     fps:measurements.length ? Math.round(1000*measurements.length/measurements.reduce((a,b)=>a+b,0)) : 0,
     drawCalls:renderer.info.render.calls, triangles:renderer.info.render.triangles, cachedImages:cache.size
    });
   }
  }
 }
 if ((scanning && sweep) || probeMotion || cameraTransition || wheelZoom || transition || orbitChanged || (sceneReady && shadowDirty)) scheduleFrame();
}

function markPlayback(on) {
 scanning = on;
 $('scan-label').textContent = on ? 'Pause scan' : 'Auto scan';
 $('auto-scan').setAttribute('aria-pressed', String(on));
}

// Reduce only the moving 3D backing buffer when consecutive frames miss 30 fps.
// Ultrasound and categorical overlays retain their own display resolution.
function adaptScanResolution(gap) {
 if (!sceneReady || motionQuality <= .65) return;
 slowFrames = gap > 36 ? slowFrames+1 : Math.max(0,slowFrames-2);
 if (slowFrames < 7) return;
 motionQuality = motionQuality === 1 ? .8 : .65;
 renderer.setPixelRatio(stillPixelRatio * motionQuality);
 slowFrames = 0;
}

function stopScan(keepPositionInput = false) {
 if (!scanning) return;
 const input = $('position'), requested = Number(input.value);
 markPlayback(false);
 sweep = null;
 generation++;
 cancelUnusedTiles(new Set(current?.cacheKeys));
 if (renderer && motionQuality < 1) renderer.setPixelRatio(stillPixelRatio);
 motionQuality = 1;
 slowFrames = 0;
 lastShadowUpdate = -Infinity;
 clearTimeout(loadingTimer);
 $('image-loading').hidden = true;
 input.step = '1';
 if (current?.blend) {
  const {a,b,u} = current.blend;
  showFrame(u < .5 ? a : b, false);
 }
 restoreControls();
 if (keepPositionInput) input.value = Math.round(requested);
 $('scene').dataset.playbackActive = 'false';
}

function paintSweep(now) {
 const s = sweep, last = s.records.length-1;
 const position = sweepPosition(now-s.start,s.phase,last);
 const i = Math.min(last-1, Math.floor(position)), u = position-i;
 const a = s.records[i], b = s.records[i+1], near = u < .5 ? a : b;
 liveQ = s.curve(position);
 applyPose(liveQ);
 current = {...near,blend:{a,b,u},playbackPosition:position};
 if (s.lastPose !== near.pose.index) {
  updateImageMode(current);
  updateShadowControl(near.pose);
  s.lastPose = near.pose.index;
 }
 drawUltrasound();
 const angle = s.phase + (now-s.start)*2*Math.PI/16000;
 scanDirection = Math.sin(angle) >= 0 ? 1 : -1;
 if (s.lastFrame) {
  const gap = now - s.lastFrame;
  s.gaps.push(gap);
  adaptScanResolution(gap);
 }
 s.lastFrame = now;
 if (s.gaps.length > 160) s.gaps.shift();
 if (now-s.lastUI >= 40 || now === s.start) {
  s.lastUI = now;
  const slider = $('position'), mm = manifest.positions[i]*(1-u) + manifest.positions[i+1]*u;
  slider.value = position;
  $('position-value').textContent = signed(Math.round(mm*10)/10,' mm');
  slider.style.setProperty('--fill', (100*position/last)+'%');
  slider.setAttribute('aria-valuetext',$('position-value').textContent);
  $('explorer').dataset.pose = String(near.pose.index);
  $('explorer').dataset.state = JSON.stringify(near.state);
 }
 if (now-s.lastReport > 1000) {
  s.lastReport = now;
  const gaps = [...s.gaps].sort((x,y)=>x-y);
  $('scene').dataset.playbackStats = JSON.stringify({
   clock:'continuous', nativeViews:s.records.length, position, blend:u,
   p95FrameMs:Math.round(gaps[Math.floor(gaps.length*.95)] || 0), maxFrameMs:Math.round(gaps.at(-1) || 0)
  });
 }
}

async function loadSweep(state) {
 const token = beginRequest(), mode = displayMode, guided = showGuidance;
 try {
  const tiles = await loadViewTiles(activeOrgan,manifest,state,mode,guided,token,true);
  if (!scanning || token !== generation) return;
  const records = manifest.positions.map((_,position) => frameRecord(
   {...state,position}, mode, guided, tiles.map(t => ({...t,sx:position*t.sw}))
  ));
  const last = records.length-1, start = performance.now();
  // Continue on the same clock while a comparison or appearance track is loading.
  const phase = sweep ? sweep.phase+(start-sweep.start)*2*Math.PI/16000 : sweepPhase(state.position,last,scanDirection);
  sweep = {start,phase,records,curve:createJointCurve(records.map(r=>r.pose.q)),gaps:[],lastUI:0,lastReport:0,lastFrame:0};
  probeMotion = transition = null;
  $('position').step = 'any';
  $('scene').dataset.playbackActive = 'true';
  $('scene').dataset.motionActive = 'false';
  paintSweep(start);
  setStatus(sceneUnavailable ? '' : orbitHint());
  scheduleFrame();
 } catch (error) {
  if (token !== generation || error.name === 'AbortError') return;
  stopScan();
  setStatus('The scan could not be loaded. Select Auto scan to retry.');
 } finally {
  finishRequest(token);
 }
}

function updateSelection(animate) {
 const state = readState();
 if (scanning) { paintValues(); loadSweep(state); }
 else requestState(state, animate);
}

for (const input of inputs) {
 input.addEventListener('input', () => {
  if (input.id === 'position') stopScan(true);
  updateSelection(true);
 });
}
for (const id of ['position','auto-scan']) {
 const element = $(id);
 element.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') warmScan(); });
 element.addEventListener('focus',warmScan);
}
$('auto-scan').addEventListener('click', () => {
 if (scanning) { stopScan(); return; }
 markPlayback(true);
 loadSweep(readState());
});
$('guidance-toggle').addEventListener('change', event => {
 showGuidance = event.target.checked;
 updateSelection(false);
});
for (const button of document.querySelectorAll('[data-view]')) {
 button.addEventListener('click', () => {
  if (displayMode === button.dataset.view) return;
  displayMode = button.dataset.view;
  markViewButtons();
  updateSelection(false);
 });
}
function redrawComparison() {
 syncComparison();
 transition = null;
 drawUltrasound();
}
function moveDividerTo(clientX) {
 const bounds = compareDivider.getBoundingClientRect();
 if (!bounds.width) return;
 const percent = Math.round(100 * (clientX - bounds.left) / bounds.width);
 const value = Math.min(100, Math.max(0, percent));
 if (compareRange.valueAsNumber === value) return;
 compareRange.valueAsNumber = value;
 redrawComparison();
}
compareRange.addEventListener('input', redrawComparison);

// Wait for a horizontal touch gesture so scrolling through the image keeps the split.
let dividerGesture = null;
compareDivider.addEventListener('pointerdown', event => {
 if (!event.isPrimary || event.button !== 0) return;
 const dragging = event.pointerType !== 'touch';
 dividerGesture = {id:event.pointerId, x:event.clientX, y:event.clientY, dragging};
 compareDivider.setPointerCapture(event.pointerId);
 if (dragging) {
  event.preventDefault();
  compareRange.focus({preventScroll:true});
  moveDividerTo(event.clientX);
 }
});
compareDivider.addEventListener('pointermove', event => {
 if (dividerGesture?.id !== event.pointerId) return;
 if (!dividerGesture.dragging) {
  const dx = Math.abs(event.clientX - dividerGesture.x), dy = Math.abs(event.clientY - dividerGesture.y);
  if (Math.max(dx, dy) < 6) return;
  if (dy > dx) { dividerGesture = null; return; }
  dividerGesture.dragging = true;
 }
 moveDividerTo(event.clientX);
});
compareDivider.addEventListener('pointerup', event => {
 if (dividerGesture?.id !== event.pointerId) return;
 moveDividerTo(event.clientX);
 dividerGesture = null;
});
compareDivider.addEventListener('lostpointercapture', event => {
 if (dividerGesture?.id === event.pointerId) dividerGesture = null;
});
$('patient-toggle').addEventListener('change', e => { environment?.setPatientVisible(e.target.checked); invalidate(); });
$('camera-overview').addEventListener('click', () => { wideView = !wideView; resetCamera(true); });
$('camera-reset').addEventListener('click', () => { wideView = false; resetCamera(true); });
for (const button of organButtons) button.addEventListener('click', () => switchOrgan(button.dataset.organ));

function expandViewer(expanded) {
 const explorer = $('explorer');
 if (explorer.classList.contains('is-expanded') === expanded) return;
 explorer.classList.toggle('is-expanded',expanded);
 document.documentElement.classList.toggle('viewer-expanded',expanded);
 if (expanded) {
  explorer.prepend($('demo-actions'));
  $('demo-actions').append($('fullscreen'));
  explorer.setAttribute('role','dialog');
  explorer.setAttribute('aria-modal','true');
  explorer.setAttribute('aria-labelledby','demo-heading');
 } else {
  document.querySelector('.scene-actions').append($('fullscreen'));
  document.querySelector('.demo-intro').append($('demo-actions'));
  for (const key of ['role','aria-modal','aria-labelledby']) explorer.removeAttribute(key);
 }
 $('fullscreen').focus({preventScroll:true});
 $('fullscreen').setAttribute('aria-pressed',String(expanded));
 $('fullscreen').setAttribute('aria-label',expanded ? 'Exit expanded viewer' : 'Expand interactive viewer');
 $('fullscreen').title = expanded ? 'Exit expanded view (Esc)' : 'Expand viewer';
 invalidate();
}
$('fullscreen').addEventListener('click', () => expandViewer(!$('explorer').classList.contains('is-expanded')));
document.addEventListener('keydown', event => {
 const explorer = $('explorer');
 if (!explorer.classList.contains('is-expanded')) return;
 if (event.key === 'Escape') { expandViewer(false); return; }
 if (event.key !== 'Tab') return;
 const controls = [...explorer.querySelectorAll('button:enabled, input:enabled')].filter(el => el.getClientRects().length);
 if ((event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls.at(-1))) {
  event.preventDefault();
  (event.shiftKey ? controls.at(-1) : controls[0]).focus();
 }
});
$('reset-demo').addEventListener('click', () => {
 stopScan();
 displayMode = 'output'; showGuidance = false; scanDirection = 1;
 markViewButtons();
 compareRange.value = '50';
 redrawComparison();
 $('patient-toggle').checked = true;
 environment?.setPatientVisible(true);
 wideView = false;
 for (const input of inputs) input.value = manifest.defaults[input.id];
 requestState(readState(),false).then(() => resetCamera());
});

new IntersectionObserver(entries => {
 inView = entries[0].isIntersecting;
 if (inView) invalidate();
 else stopScan();
}, {rootMargin:'100px'}).observe($('explorer'));
document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan(); else invalidate(); });
document.addEventListener('sonobridge:pause', () => stopScan());

async function init() {
 try {
  manifest = await getManifest(activeOrgan);
  configureDataset();
  new ResizeObserver(resizeImage).observe(document.querySelector('.image-stage'));
  setupScene().catch(error => {
   console.error('[SonoBridge] 3D initialization',error);
   sceneUnavailable = true;
   sceneReady = false;
   $('scene-loading').classList.remove('anatomy-progress');
   $('scene-loading').textContent = '3D is unavailable on this device.';
   for (const id of ['camera-reset','camera-overview','patient-toggle']) $(id).disabled = true;
   organButtons.forEach(button => button.disabled = false);
   if (current) setStatus('');
  });
  await requestState(readState(),false);
  if (!current) throw Error('Initial ultrasound unavailable');
  setControlsEnabled(true);
  $('explorer').setAttribute('aria-busy','false');
  $('explorer').dataset.ready = 'true';
 } catch (error) {
  console.error('[SonoBridge] initialization',error);
  setStatus('The demo could not be loaded. Please reload to retry.');
  $('image-loading').hidden = true;
  $('explorer').setAttribute('aria-busy','false');
 }
}
init();
