// Lightweight clinical context; the scanned abdomen remains CT-derived.
export function createEnvironment(T,scene,patientAsset){
 const group=new T.Group();group.name='clinical_context';scene.add(group);
 const mat=(color,roughness=.8,metalness=0)=>new T.MeshStandardMaterial({color,roughness,metalness});
 const upholstery=mat(0x85828e,.96),metal=mat(0xb1b0b7,.68,.08),base=mat(0x8c8a94,.75,.06),seam=mat(0x9f9ca8,.9);
 function rounded(name,size,position,material,r=.015){
  const [w,h,d]=size;const b=Math.min(r,d*.22),x=w/2-b,y=h/2-b,k=Math.min(r,x,y),s=new T.Shape();
  s.moveTo(-x+k,-y);s.lineTo(x-k,-y);s.quadraticCurveTo(x,-y,x,-y+k);s.lineTo(x,y-k);s.quadraticCurveTo(x,y,x-k,y);s.lineTo(-x+k,y);s.quadraticCurveTo(-x,y,-x,y-k);s.lineTo(-x,-y+k);s.quadraticCurveTo(-x,-y,-x+k,-y);
  const geometry=new T.ExtrudeGeometry(s,{depth:d-2*b,bevelEnabled:true,bevelThickness:b,bevelSize:b,bevelSegments:3,curveSegments:5,steps:1});geometry.translate(0,0,-d/2+b);
  const mesh=new T.Mesh(geometry,material);mesh.name=name;mesh.position.set(...position);mesh.receiveShadow=true;mesh.castShadow=true;group.add(mesh);return mesh;
 }
 rounded('mattress',[.68,2.02,.06],[0,.38,.69],upholstery,.023);
 rounded('mattress_piping',[.686,2.026,.008],[0,.38,.674],seam,.006);
 rounded('bed_frame',[.70,2.04,.038],[0,.38,.642],metal,.016);
 rounded('bed_column',[.18,.30,.57],[0,.38,.34],metal,.018);
 rounded('bed_base',[.52,.76,.075],[0,.38,.0325],base,.025);
 rounded('robot_pedestal',[.30,.30,.70],[.505,.12,.35],metal,.018);
 rounded('pedestal_foot',[.35,.35,.035],[.505,.12,.0125],base,.012);
 // A thin dark collar makes the existing calibrated mounting plate readable.
 rounded('pedestal_top',[.30,.30,.014],[.505,.12,.692],base,.01);
 // Keep the CSS backdrop continuous through the scene, with only a soft grounding shadow.
 const floor=new T.Mesh(new T.PlaneGeometry(200,200),new T.ShadowMaterial({color:0x746e82,opacity:.12,depthWrite:false}));floor.position.z=-.005;floor.receiveShadow=true;group.add(floor);
 const silhouette=patientAsset;silhouette.name='illustrative_patient';group.add(silhouette);
 const cutCenter={value:new Float32Array(2)},cutHalf={value:new Float32Array([.21,.18])};
 const ghost=new T.MeshStandardMaterial({color:0xa7a6ad,roughness:1,metalness:0,envMapIntensity:.12,transparent:true,opacity:.5,depthWrite:false,side:T.FrontSide});
 // One connected surface avoids the overlapping rings of separate body parts.
 // A soft anatomical window keeps the actual CT surface and organs readable.
 ghost.onBeforeCompile=shader=>{
  shader.uniforms.patientCutCenter=cutCenter;shader.uniforms.patientCutHalf=cutHalf;
  shader.vertexShader='varying vec2 vPatientWorld;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>','#include <worldpos_vertex>\n vPatientWorld=(modelMatrix*vec4(transformed,1.0)).xy;');
  shader.fragmentShader='uniform vec2 patientCutCenter;\nuniform vec2 patientCutHalf;\nvarying vec2 vPatientWorld;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
   float patientRim=pow(1.0-abs(dot(normal,normalize(vViewPosition))),2.0);
   float patientWindow=1.0-smoothstep(0.72,1.18,length((vPatientWorld-patientCutCenter)/patientCutHalf));
   diffuseColor.a=mix(0.30+0.12*patientRim,0.012+0.045*patientRim,patientWindow);`);
 };
 ghost.customProgramCacheKey=()=> 'patient-window-v2';
 silhouette.traverse(o=>{if(o.isMesh){o.material=ghost;o.renderOrder=7;o.castShadow=false;o.receiveShadow=false;}});
 function alignPatient(bounds,posture='supine'){
  const center=bounds.getCenter(new T.Vector3()),size=bounds.getSize(new T.Vector3());
  silhouette.position.set(center.x,center.y,bounds.min.z);silhouette.scale.set(size.x/.4,1,size.z/.28);
  silhouette.traverse(o=>{if(o.isMesh)o.visible=o.name===`patient_${posture}`;});
  cutCenter.value.set([center.x,center.y]);cutHalf.value.set([size.x*.62,size.y*.86]);
  group.userData.patientAlignment={ctCenter:center.toArray(),ctBounds:[bounds.min.toArray(),bounds.max.toArray()],mattressTop:.72,posture,backFacingUp:posture==='prone',illustrative:true,connectedSurface:true};
 }
 return {group,alignPatient,setPatientVisible:on=>silhouette.visible=on,
  setScanView:on=>{upholstery.color.set(on?0xaaa7b3:0x85828e);seam.color.set(on?0xc2bfcb:0x9f9ca8);},dispose:()=>{}};
}
