"""Bake two lightweight resting poses from the CC0 MakeHuman base mesh.

Run with Blender. Source assets and their original license are kept under
refs/demo-build/patient-v2; the site ships only the baked mesh and asset license.
"""
from pathlib import Path
import bpy,json,numpy as np
ROOT=Path(__file__).resolve().parents[2];WORK=ROOT/'refs/demo-build/patient-v2'
vertices=[];faces=[];group=''
for line in (WORK/'base.obj').read_text().splitlines():
 if line.startswith('v '):vertices.append([float(x) for x in line.split()[1:4]])
 elif line.startswith('g '):group=line[2:]
 elif line.startswith('f ') and group=='body':faces.append([int(x.split('/')[0])-1 for x in line.split()[1:]])
v=np.array(vertices);body_vertices=np.unique(np.concatenate(faces));skeleton=json.loads((WORK/'default.mhskel').read_text());weights=json.loads((WORK/'default_weights.mhw').read_text())['weights'];bones=skeleton['bones']
def point(bone,end):return v[skeleton['joints'][bones[bone][end]]].mean(0)
def rotation(a,b):
 a=a/np.linalg.norm(a);b=b/np.linalg.norm(b);w=np.cross(a,b);c=np.dot(a,b)
 k=np.array([[0,-w[2],w[1]],[w[2],0,-w[0]],[-w[1],w[0],0]])
 return np.eye(3)+k+k@k/(1+c)
def descendants(root):
 found={root}
 while True:
  out=found|{n for n,b in bones.items() if b['parent'] in found}
  if out==found:return found
  found=out
def transform(origin,target,r):
 t=np.eye(4);t[:3,:3]=r;t[:3,3]=target-r@origin;return t
def posed(prone):
 matrices={name:np.eye(4) for name in bones}
 for side,sign in [('L',1),('R',-1)]:
  upper='upperarm01.'+side;lower='lowerarm01.'+side
  shoulder=point(upper,'head');elbow=point(lower,'head');wrist=point('wrist.'+side,'head')
  r=rotation(elbow-shoulder,np.array([sign*.33,-2.3,0.]));newelbow=shoulder+r@(elbow-shoulder)
  for name in descendants(upper):matrices[name]=transform(shoulder,shoulder,r)
  r=rotation(wrist-elbow,np.array([sign*.06,-2.2,-.05]))
  for name in descendants(lower):matrices[name]=transform(elbow,newelbow,r)
  upper='upperleg01.'+side;lower='lowerleg01.'+side
  hip=point(upper,'head');knee=point(lower,'head');ankle=point('foot.'+side,'head')
  r=rotation(knee-hip,np.array([sign*.08,-4.1,.10]));newknee=hip+r@(knee-hip)
  for name in descendants(upper):matrices[name]=transform(hip,hip,r)
  r=rotation(ankle-knee,np.array([sign*.03,-3.8,-.25]))
  for name in descendants(lower):matrices[name]=transform(knee,newknee,r)
 if prone:
  # Turn the resting head to the side while the trunk remains face down.
  origin=point('head','head');angle=1.12;r=np.array([[np.cos(angle),0,np.sin(angle)],[0,1,0],[-np.sin(angle),0,np.cos(angle)]])
  for name in descendants('head'):matrices[name]=transform(origin,origin,r)
 out=np.zeros_like(v);total=np.zeros(len(v))
 for name,items in weights.items():
  ids=np.array([p[0] for p in items]);w=np.array([p[1] for p in items]);t=matrices.get(name,np.eye(4))
  out[ids]+=(v[ids]@t[:3,:3].T+t[:3,3])*w[:,None];total[ids]+=w
 out[total>0]/=total[total>0,None];out[total==0]=v[total==0]
 # In the website, X is lateral, Y points toward the feet, Z is up.
 out[:,1]=3.2-out[:,1];out*=.1
 body=out[body_vertices];abdomen=body[(abs(body[:,1])<.065)&(abs(body[:,0])<.18)]
 low=abdomen.min(0);high=abdomen.max(0)
 out[:,0]*=.4/(high[0]-low[0]);out[:,2]=(out[:,2]-low[2])*.28/(high[2]-low[2])
 if prone:out[:,0]*=-1;out[:,2]=.28-out[:,2]
 # The bed supports the body; flatten only the small contact patches.
 out[:,2]=np.maximum(out[:,2],.004)
 return out
bpy.ops.wm.read_factory_settings(use_empty=True);report=[]
for posture in ['supine','prone']:
 mesh=bpy.data.meshes.new(posture);mesh.from_pydata(posed(posture=='prone').tolist(),[],faces);mesh.update()
 obj=bpy.data.objects.new('patient_'+posture,mesh);bpy.context.collection.objects.link(obj);bpy.context.view_layer.objects.active=obj;obj.select_set(True)
 bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.mesh.delete_loose();bpy.ops.object.mode_set(mode='OBJECT')
 remesh=obj.modifiers.new('Continuous clinical silhouette','REMESH');remesh.mode='VOXEL';remesh.voxel_size=.0045;remesh.use_smooth_shade=True;bpy.ops.object.modifier_apply(modifier=remesh.name)
 smooth=obj.modifiers.new('Quiet surface','SMOOTH');smooth.factor=.6;smooth.iterations=4;bpy.ops.object.modifier_apply(modifier=smooth.name)
 dec=obj.modifiers.new('Web surface','DECIMATE');dec.ratio=min(1,24000/max(1,len(obj.data.polygons)*2));bpy.ops.object.modifier_apply(modifier=dec.name)
 for p in obj.data.polygons:p.use_smooth=True
 mat=bpy.data.materials.new('Clinical matte');mat.diffuse_color=(.58,.66,.65,1);obj.data.materials.append(mat)
 report.append({'posture':posture,'vertices':len(obj.data.vertices),'polygons':len(obj.data.polygons)})
 obj.select_set(False)
bpy.ops.export_scene.gltf(filepath=str(WORK/'patient.glb'),export_format='GLB',export_yup=False,export_apply=True,export_cameras=False,export_lights=False)
(WORK/'build.json').write_text(json.dumps(report,indent=2));print(report)
