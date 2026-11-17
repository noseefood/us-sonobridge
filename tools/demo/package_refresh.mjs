import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS,EXTMeshoptCompression} from '@gltf-transform/extensions';
import {quantize,reorder,prune} from '@gltf-transform/functions';
import {MeshoptEncoder,MeshoptDecoder} from 'meshoptimizer';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {gzipSync} from 'node:zlib';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');process.chdir(root);
await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
for(const organ of ['liver','kidney']){
 const folder=`refs/demo-build/refresh/${organ}`,meta=JSON.parse(fs.readFileSync(`${folder}/grid_meta.json`));
 const doc=await io.read(`${folder}/anatomy.glb`);
 await doc.transform(prune({keepLeaves:true}),reorder({encoder:MeshoptEncoder}),quantize({quantizePosition:16,quantizeNormal:12,quantizeTexcoord:14}));
 doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
 const bytes=await io.writeBinary(doc),out=`static/demo/${organ}/anatomy-${meta.case_id}.compact.glb`;
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,bytes);fs.writeFileSync(out+'.gz',gzipSync(bytes,{level:9}));
 const manifestPath=`static/demo/${organ}/manifest-v3.json`;
 if(fs.existsSync(manifestPath)){
  const m=JSON.parse(fs.readFileSync(manifestPath)),surfaces=JSON.parse(fs.readFileSync(`${folder}/surfaces/surfaces.json`));
  m.anatomy_labels=surfaces.map(s=>({id:s.label,name:s.name}));fs.writeFileSync(manifestPath,JSON.stringify(m));
 }
 console.log(organ,bytes.length,'bytes',doc.getRoot().listMeshes().map(m=>m.getName()));
}
for(const file of ['static/js/demo.js','static/js/environment.js','static/css/demo.css','static/demo/liver/manifest-v3.json','static/demo/kidney/manifest-v3.json'])if(fs.existsSync(file))fs.writeFileSync(file+'.gz',gzipSync(fs.readFileSync(file),{level:9}));
