// Lightweight clinical context; the scanned abdomen remains CT-derived.
export function createEnvironment(T,scene){
 const group=new T.Group();group.name='clinical_context';scene.add(group);
 const mat=(color,roughness=.8,metalness=0)=>new T.MeshStandardMaterial({color,roughness,metalness});
 const upholstery=mat(0x657d83,.96),metal=mat(0xaab4b6,.68,.08),base=mat(0x7e8f94,.75,.06),seam=mat(0x84999d,.9);
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
 const floor=new T.Mesh(new T.PlaneGeometry(200,200),mat(0xe8e9e6,.95));floor.position.z=-.005;floor.receiveShadow=true;group.add(floor);
 const silhouette=new T.Group();silhouette.name='illustrative_patient';group.add(silhouette);
 const ghost=new T.MeshStandardMaterial({color:0x6f9296,roughness:1,transparent:true,opacity:.1,depthWrite:false,side:T.FrontSide});
 ghost.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\n diffuseColor.a = 0.035 + 0.28 * pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.3);');};
 const sphere=new T.SphereGeometry(1,20,12);
 function ellipsoid(name,position,size){const o=new T.Mesh(sphere,ghost);o.name=name;o.position.set(...position);o.scale.set(...size);o.renderOrder=7;silhouette.add(o);return o;}
 function limb(name,a,b,r){const delta=new T.Vector3(...b).sub(new T.Vector3(...a));const o=new T.Mesh(new T.CapsuleGeometry(r,Math.max(.001,delta.length()-2*r),5,12),ghost);o.name=name;o.position.copy(new T.Vector3(...a).add(new T.Vector3(...b)).multiplyScalar(.5));o.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());o.renderOrder=7;silhouette.add(o);}
 function alignPatient(bounds,posture='supine'){
  for(const o of [...silhouette.children]){silhouette.remove(o);if(o.geometry!==sphere)o.geometry.dispose();}
  const center=bounds.getCenter(new T.Vector3()),size=bounds.getSize(new T.Vector3()),cx=center.x,cy=center.y,prone=posture==='prone';
  const sx=Math.max(.8,Math.min(1.12,size.x/.42)),height=Math.max(.22,Math.min(.36,size.z));
  const rows=[[-.42,.07,.06],[-.35,.17,.09],[-.25,.225,.12],[-.12,.21,.145],[0,.20,height*.5],[.14,.18,height*.44],[.27,.175,.11],[.34,.12,.08]];
  const radial=new T.CatmullRomCurve3(rows.map(([y,rx,rz])=>new T.Vector3(rx*sx,y,rz)));
  const vertices=[],indices=[];const n=50,m=36;
  // The back has a broader, flatter profile than the anterior surface. Only
  // this illustrative outline changes; CT anatomy and probe poses are already
  // exported in their native supine/prone acquisition coordinates.
  for(let i=0;i<=n;i++){const p=radial.getPoint(i/n);for(let j=0;j<=m;j++){const a=j/m*Math.PI*2,s=Math.sin(a),back=prone?s>=0:s<0,z=Math.sign(s)*Math.pow(Math.abs(s),back?.7:1);vertices.push(cx+p.x*Math.cos(a),cy+p.y,.728+p.z+p.z*z);}}
  for(let i=0;i<n;i++)for(let j=0;j<m;j++){const a=i*(m+1)+j,b=a+m+1;indices.push(a,b,a+1,a+1,b,b+1);}
  const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();const torso=new T.Mesh(g,ghost);torso.name='illustrative_torso';torso.renderOrder=7;silhouette.add(torso);
  const headZ=prone?.847:.823,anterior=prone?-1:1;
  ellipsoid('head',[cx,cy-.555,headZ],[.085*sx,.12,.095]);
  // A subtle face profile makes face-up / face-down readable without a label.
  ellipsoid('nose',[cx,cy-.56,headZ+anterior*.093],[.017*sx,.027,.026]);
  ellipsoid('chin',[cx,cy-.476,headZ+anterior*.052],[.037*sx,.034,.029]);
  limb('neck',[cx,cy-.43,.80],[cx,cy-.37,.80],.055*sx);
  for(const side of [-1,1]){
   const shoulder=[cx+side*.22*sx,cy-.25,.84],elbow=[cx+side*.275*sx,cy+.02,.78],wrist=[cx+side*.255*sx,cy+.29,.77];
   limb('upper_arm',shoulder,elbow,.043*sx);limb('forearm',elbow,wrist,.033*sx);ellipsoid('hand',[wrist[0],wrist[1]+.045,.766],[.033,.065,.024]);
   const hip=[cx+side*.095*sx,cy+.27,.815],knee=[cx+side*.09*sx,cy+.65,.78],ankle=[cx+side*.085*sx,cy+.99,.76];
   limb('thigh',hip,knee,.073*sx);limb('calf',knee,ankle,.049*sx);ellipsoid('foot',[ankle[0],cy+1.055,.763],[.045,.09,.035]);
  }
  group.userData.patientAlignment={ctCenter:center.toArray(),ctBounds:[bounds.min.toArray(),bounds.max.toArray()],mattressTop:.72,posture,backFacingUp:prone,illustrative:true};
 }
 return {group,alignPatient,setPatientVisible:on=>silhouette.visible=on,
  setScanView:on=>{upholstery.color.set(on?0x94aaae:0x657d83);seam.color.set(on?0xb4c3c4:0x84999d);},dispose:()=>{}};
}
