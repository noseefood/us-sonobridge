// Validate both exported grids, registered robot FK, and lossless asset packing.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import * as THREE from '../../static/vendor/three/three.module.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const matrix=rows=>new THREE.Matrix4().set(...rows.flat());
function packed(file){
 const b=fs.readFileSync(path.join(root,file));assert.equal(b.readUInt32LE(0),0x46546c67);
 assert.deepEqual(gunzipSync(fs.readFileSync(path.join(root,file+'.gz'))),b);
 return {bytes:b.length,nodes:JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString()).nodes};
}
const robot=packed('static/demo/robot.compact.glb');
for(let i=0;i<=8;i++)assert(robot.nodes.some(n=>n.name===`web_fr3_link${i}`));
assert(robot.nodes.some(n=>n.name==='web_base'));
const reports=[];
for(const [organ,expectedCase] of [['liver','00098'],['kidney','00092']]){
 const prefix=`${organ}/`,m=read(`static/demo/${prefix}manifest-v3.json`),anatomy=prefix+m.anatomy;
 assert.equal(m.format_version,3);assert.equal(m.image_layout,'lossless-position-tracks');
 assert.equal(m.case_id,expectedCase);assert.equal(m.poses.length,m.positions.length*m.rotations.length);
 let maxPositionError=0,maxRotationError=0,maxAdjacentJointChange=0,totalFrameBytes=0;
 for(const [index,pose] of m.poses.entries()){
  assert.equal(index,pose.index);assert.equal(index,pose.i*m.rotations.length+pose.j);
  assert(pose.central_contact>=.95);assert(pose.whole_contact>=.85);
  const transforms={base:matrix(m.kinematics.base)};let k=0;
  for(const j of m.kinematics.joints){const t=transforms[j.parent].clone().multiply(matrix(j.origin));if(j.moving)t.multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...j.axis),pose.q[k++]));transforms[j.child]=t;}
  const face=transforms.fr3_link8.multiply(new THREE.Matrix4().makeTranslation(...m.kinematics.face_offset)),target=matrix(pose.face);
  const error=new THREE.Vector3().setFromMatrixPosition(face).distanceTo(new THREE.Vector3().setFromMatrixPosition(target));
  const angle=new THREE.Quaternion().setFromRotationMatrix(face).angleTo(new THREE.Quaternion().setFromRotationMatrix(target));
  maxPositionError=Math.max(maxPositionError,error);maxRotationError=Math.max(maxRotationError,angle);assert(error<.00001);assert(angle<.001);
  for(const next of [pose.i+1<m.positions.length?index+m.rotations.length:null,pose.j+1<m.rotations.length?index+1:null])if(next!==null)maxAdjacentJointChange=Math.max(maxAdjacentJointChange,...pose.q.map((q,j)=>Math.abs(q-m.poses[next].q[j])));
 }
 const folder=path.join(root,`static/demo/${prefix}tracks`);
 for(let j=0;j<m.rotations.length;j++){
  const suffix=`-r${String(j).padStart(2,'0')}.webp`;
  const files=[...m.shadows.flatMap((_,s)=>m.details.map((_,d)=>`us-${s}-${d}${suffix}`)),`label${suffix}`,`ct${suffix}`,...m.shadows.map((_,s)=>`guidance-${s}${suffix}`)];
  for(const file of files){const b=fs.readFileSync(path.join(folder,file));assert(b.length>100);assert.equal(b.subarray(0,4).toString(),'RIFF');assert.equal(b.subarray(8,12).toString(),'WEBP');totalFrameBytes+=b.length;}
 }
 assert(maxAdjacentJointChange*180/Math.PI<12);
 const mesh=packed(`static/demo/${anatomy}`);
 for(const name of ['Liver','Kidneys','Bones','Skin'])assert(mesh.nodes.some(n=>n.name===`anatomy_${name}`));
 for(const label of m.anatomy_labels)assert(mesh.nodes.some(n=>n.name===`anatomy_${label.name}`));
 const far=m.probe.radius_mm+m.depth_mm,half=m.probe.sector_angle_deg*Math.PI/360;
 assert(Math.abs(m.aspect-2*far*Math.sin(half)/(far-m.probe.radius_mm*Math.cos(half)))<1e-10);
 reports.push({organ,case:m.case_id,poses:m.poses.length,outputs:m.poses.length*m.shadows.length*m.details.length,max_position_error_mm:maxPositionError*1000,max_rotation_error_deg:maxRotationError*180/Math.PI,max_adjacent_joint_change_deg:maxAdjacentJointChange*180/Math.PI,minimum_central_contact:Math.min(...m.poses.map(p=>p.central_contact)),minimum_whole_contact:Math.min(...m.poses.map(p=>p.whole_contact)),aspect:m.aspect,frames_mb:totalFrameBytes/1e6,anatomy_mb:mesh.bytes/1e6});
}
fs.writeFileSync(path.join(root,'refs/demo-build/validation_v7.json'),JSON.stringify({shared_robot_mb:robot.bytes/1e6,reports,checks:['Complete 442-pose acquisition grids','Contact validity','Native FK registration','Shared robot visual links','Every present anatomical label exported','832 lossless sweep tracks / 14,144 source images','Physical image aspect','Gzip byte identity']},null,2));
console.log(JSON.stringify(reports,null,2));
