// Shared robot + independent anatomy assets; gzip is decoded by the browser.
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS,EXTMeshoptCompression} from '@gltf-transform/extensions';
import {quantize,reorder,prune} from '@gltf-transform/functions';
import {MeshoptEncoder,MeshoptDecoder} from 'meshoptimizer';
import {build} from 'esbuild';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {gzipSync} from 'node:zlib';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');process.chdir(root);
await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
async function pack(source,out,kind){
 const doc=await io.read(source);
 for(const n of doc.getRoot().listNodes())if((kind==='robot'&&n.getName().startsWith('anatomy_'))||(kind==='anatomy'&&n.getName().startsWith('web_')))n.dispose();
 await doc.transform(prune({keepLeaves:true}),reorder({encoder:MeshoptEncoder}),quantize({quantizePosition:16,quantizeNormal:12,quantizeTexcoord:14}));
 doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
 const bytes=await io.writeBinary(doc),gz=gzipSync(bytes,{level:9});fs.writeFileSync(out,bytes);fs.writeFileSync(out+'.gz',gz);
 console.log(kind,out,bytes.length,gz.length);
}
await pack('refs/demo-build/scene-source.glb','static/demo/robot.compact.glb','robot');
await pack('refs/demo-build/scene-source.glb','static/demo/liver.compact.glb','anatomy');
if(fs.existsSync('refs/demo-build/kidney/anatomy.glb'))await pack('refs/demo-build/kidney/anatomy.glb','static/demo/kidney/anatomy.compact.glb','anatomy');
// Expose when the native outputs actually support shadow adjustment in a view.
for(const prefix of ['', 'kidney/']){
 const file=`static/demo/${prefix}manifest.json`;if(!fs.existsSync(file))continue;
 const m=JSON.parse(fs.readFileSync(file));
 for(const p of m.poses){const dir=`static/demo/${prefix}frames/${String(p.index).padStart(3,'0')}`;
  p.shadow_control=m.details.some((_,d)=>!fs.readFileSync(`${dir}/us-0-${d}.webp`).equals(fs.readFileSync(`${dir}/us-4-${d}.webp`)));
 }
 fs.writeFileSync(file,JSON.stringify(m));console.log(prefix||'liver/',m.poses.filter(p=>p.shadow_control).length,'views with active shadow control');
}
await build({entryPoints:['tools/demo/scene-runtime.js'],outfile:'static/vendor/scene-runtime.js',bundle:true,minify:true,format:'esm',target:['es2020'],alias:{three:path.resolve('static/vendor/three/three.module.js')},legalComments:'linked'});
for(const file of ['static/vendor/scene-runtime.js','static/js/demo.js','static/js/environment.js','static/css/demo.css','static/css/bulma.min.css','static/css/index.css','static/demo/manifest.json','static/demo/kidney/manifest.json']){
 if(fs.existsSync(file))fs.writeFileSync(file+'.gz',gzipSync(fs.readFileSync(file),{level:9}));
}
