// Offline camera study on the unchanged CAD and anatomy; no scene assets written.
import {NodeIO} from '@gltf-transform/core';
import fs from 'node:fs';
import * as T from '../../static/vendor/three/three.module.js';
const io=new NodeIO(),m=JSON.parse(fs.readFileSync('static/demo/kidney/manifest.json'));
const matrix=a=>new T.Matrix4().set(...a.flat()),q=m.poses[m.defaults.position*13+m.defaults.rotation].q;
const tf={base:matrix(m.kinematics.base)};let k=0;
for(const j of m.kinematics.joints){const t=tf[j.parent].clone().multiply(matrix(j.origin));if(j.moving)t.multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(...j.axis),q[k++]));tf[j.child]=t;}
const robot=await io.read('refs/demo-build/scene-source.glb'),anatomy=await io.read('refs/demo-build/kidney/anatomy.glb');
for(const n of robot.getRoot().listNodes())if(tf[n.getName().slice(4)])n.setMatrix(tf[n.getName().slice(4)].elements);
const points=[],focus=[],robotParts=[];
for(const [doc,kind] of [[robot,'robot'],[anatomy,'anatomy']])for(const node of doc.getRoot().listNodes()){
 if(!node.getMesh()||(kind==='robot'&&node.getName().startsWith('anatomy_')))continue;
 const mat=new T.Matrix4().fromArray(node.getWorldMatrix()),pts=[];
 for(const prim of node.getMesh().listPrimitives()){
  const a=prim.getAttribute('POSITION').getArray(),step=3*Math.max(1,Math.floor(a.length/3/1800));
  for(let i=0;i<a.length;i+=step){const p=new T.Vector3(a[i],a[i+1],a[i+2]).applyMatrix4(mat);points.push(p);pts.push(p);if(node.getName()==='anatomy_Kidneys'&&p.x>0)focus.push(p);}
 }
 if(kind==='robot')robotParts.push(pts);
}
const box=new T.Box3().setFromPoints(points),target=box.getCenter(new T.Vector3());
const normals=m.poses.map(p=>new T.Vector3(p.face[0][1],p.face[1][1],p.face[2][1]));
const results=[];const aspect=680/420;
function rect(points,d,r,u,distance,tanY){let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const p0 of points){const p=p0.clone().sub(target),z=distance-p.dot(d),x=p.dot(r)/z/tanY/aspect,y=p.dot(u)/z/tanY;x0=Math.min(x,x0);x1=Math.max(x,x1);y0=Math.min(y,y0);y1=Math.max(y,y1);}return {x0,x1,y0,y1,width:(x1-x0)*340,height:(y1-y0)*210};}
for(const az of [-170,-155,-140,-125,-110,-80,-65,-50,-35,25,40,55,70,110,125,140,155,170])for(const el of [15,25,35,45,55])for(const fov of [42,52,62]){
 const a=az*Math.PI/180,e=el*Math.PI/180,d=new T.Vector3(Math.cos(a)*Math.cos(e),Math.sin(a)*Math.cos(e),Math.sin(e)),r=new T.Vector3().crossVectors(new T.Vector3(0,0,1),d).normalize(),u=d.clone().cross(r),tanY=Math.tan(fov*Math.PI/360);
 const facing=Math.min(...normals.map(n=>Math.abs(n.dot(d))));if(facing<.18)continue;
 let distance=.45;for(const p0 of points){const p=p0.clone().sub(target);distance=Math.max(distance,p.dot(d)+Math.max(Math.abs(p.dot(r))/(tanY*aspect*.9),Math.abs(p.dot(u))/(tanY*.8),.04));}
 const b=rect(focus,d,r,u,distance,tanY);results.push({az,el,fov,distance:Math.round(distance*100)/100,width:Math.round(b.width),height:Math.round(b.height),score:Math.round(b.width*b.height),facing:Math.round(facing*100)/100,dir:d.toArray().map(v=>Math.round(v*100)/100)});
}
results.sort((a,b)=>b.score-a.score);console.log(JSON.stringify({points:points.length,focus:focus.length,bounds:[box.min.toArray(),box.max.toArray()],best:results.slice(0,16),front:results.filter(x=>x.az<0).slice(0,10)},null,2));
fs.writeFileSync('refs/demo-build/framing-study.json',JSON.stringify(results,null,2));
