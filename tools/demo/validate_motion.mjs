import fs from 'node:fs';import assert from 'node:assert/strict';
import * as THREE from '../../static/vendor/three/three.module.js';
import {createJointCurve,sweepPhase,sweepPosition} from '../../static/js/motion.js';
const matrix=rows=>new THREE.Matrix4().set(...rows.flat());
const reports=[];
for(const organ of ['liver','kidney']){
 const m=JSON.parse(fs.readFileSync(`refs/demo-build/continuous/${organ}/grid_meta.json`));
 let maxKnotError=0,maxLimitViolation=0,maxVelocityDiscontinuity=0,maxFaceDeviation=0;const samples=[];
 const urdf=fs.readFileSync(`/home/xuesong-li/Research_IFL/CT-MRI2US/SonoGym/apps/${organ==='liver'?'sonobridge':'sonobridge_kidney'}/assets/robots/fr3/fr3.urdf`,'utf8');
 const limits=[...urdf.matchAll(/<joint\b([^>]*?)>([\s\S]*?)<\/joint>/g)].filter(m=>m[1].includes('type="revolute"')).map(m=>{const limit=m[2].match(/<limit\b[^>]+/)[0];return [Number(limit.match(/lower="([^"]+)/)[1]),Number(limit.match(/upper="([^"]+)/)[1])];});assert.equal(limits.length,7);
 function transform(q){const t=matrix(m.kinematics.base);let k=0;for(const joint of m.kinematics.joints){t.multiply(matrix(joint.origin));if(joint.moving)t.multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...joint.axis),q[k++]));}return t.multiply(new THREE.Matrix4().makeTranslation(...m.kinematics.face_offset));}
 for(let j=0;j<13;j++){
  const poses=m.poses.filter(p=>p.j===j),q=poses.map(p=>p.q),curve=createJointCurve(q);
  for(let i=0;i<33;i++)maxKnotError=Math.max(maxKnotError,...curve(i).map((v,a)=>Math.abs(v-q[i][a])));
  for(let i=0;i<32;i++)for(let k=0;k<=20;k++){
   const t=k/20,point=curve(i+t);
   for(let a=0;a<7;a++)maxLimitViolation=Math.max(maxLimitViolation,point[a]-limits[a][1],limits[a][0]-point[a]);
   const target=new THREE.Vector3(poses[i].face[0][3],poses[i].face[1][3],poses[i].face[2][3]).lerp(new THREE.Vector3(poses[i+1].face[0][3],poses[i+1].face[1][3],poses[i+1].face[2][3]),t);
   const face=transform(point);maxFaceDeviation=Math.max(maxFaceDeviation,new THREE.Vector3().setFromMatrixPosition(face).distanceTo(target));
   if(k>0&&k<20)samples.push({position:i+t,rotation:j,face:Array.from({length:4},(_,r)=>Array.from({length:4},(_,c)=>face.elements[c*4+r]))});
  }
  for(let i=1;i<32;i++){const e=1e-5,left=curve(i-e),at=curve(i),right=curve(i+e);maxVelocityDiscontinuity=Math.max(maxVelocityDiscontinuity,...at.map((v,a)=>Math.abs((v-left[a])/e-(right[a]-v)/e)));}
 }
 assert(maxKnotError<1e-10);assert(maxLimitViolation<1e-10);assert(maxVelocityDiscontinuity<1e-4);assert(maxFaceDeviation<.001);
 const last=32;for(const pos of [0,8,16,24,32])for(const d of [-1,1])assert(Math.abs(sweepPosition(0,sweepPhase(pos,last,d),last)-pos)<1e-10);
 assert(Math.abs(sweepPosition(8000,0,last)-last)<1e-10);assert(Math.abs(sweepPosition(16000,0,last))<1e-10);
 fs.writeFileSync(`refs/demo-build/continuous/${organ}/motion-samples.json`,JSON.stringify({case:m.case_id,samples}));
 reports.push({organ,case:m.case_id,tracks:13,nativePositions:33,maxKnotError,maxLimitViolation,maxVelocityDiscontinuity,maxFaceDeviationMm:1000*maxFaceDeviation});
}
fs.writeFileSync('refs/demo-build/continuous/motion-validation.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports,null,2));
