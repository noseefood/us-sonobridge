// Offline packaging only. Serving the site does not need Node or npm.
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS,EXTMeshoptCompression} from '@gltf-transform/extensions';
import {quantize,reorder} from '@gltf-transform/functions';
import {MeshoptEncoder,MeshoptDecoder} from 'meshoptimizer';
import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
process.chdir(root);
const source=fs.existsSync('static/demo/scene.glb')?'static/demo/scene.glb':'refs/demo-build/scene-source.glb';
await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS)
 .registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
const doc=await io.read(source);
const links=new Map(doc.getRoot().listNodes().filter(n=>/^web_(base|fr3_link[0-8])$/.test(n.getName()))
 .map(n=>[n.getName(),n.getWorldMatrix()]));
const triangleCount=d=>d.getRoot().listMeshes().reduce((n,m)=>n+m.listPrimitives().reduce((s,p)=>s+p.getIndices().getCount()/3,0),0);
const triangles=triangleCount(doc);
// Only display vertices are quantized. No simplification, mesh merging or
// changes to the robot's FK groups; acquisition poses and images are untouched.
await doc.transform(reorder({encoder:MeshoptEncoder}),quantize({quantizePosition:16,quantizeNormal:12,quantizeTexcoord:14}));
doc.createExtension(EXTMeshoptCompression).setRequired(true)
 .setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
await io.write('static/demo/scene.compact.glb',doc);
const decoded=await io.read('static/demo/scene.compact.glb');
for(const [name,matrix] of links)assert.deepEqual(decoded.getRoot().listNodes().find(n=>n.getName()===name).getWorldMatrix(),matrix);
assert.equal(triangleCount(decoded),triangles);
await build({entryPoints:['tools/demo/scene-runtime.js'],outfile:'static/vendor/scene-runtime.js',
 bundle:true,minify:true,format:'esm',target:['es2020'],
 alias:{three:path.resolve('static/vendor/three/three.module.js')},legalComments:'linked'});
const p='static/demo/manifest.json',manifest=JSON.parse(fs.readFileSync(p));
Object.assign(manifest,{anatomy:'scene.compact.glb',format_version:2,image_layout:'individual-lossless-webp'});
fs.writeFileSync(p,JSON.stringify(manifest));
console.log(JSON.stringify({sourceBytes:fs.statSync(source).size,sceneBytes:fs.statSync('static/demo/scene.compact.glb').size,
 runtimeBytes:fs.statSync('static/vendor/scene-runtime.js').size,triangles,unchangedRobotTransforms:links.size}));
