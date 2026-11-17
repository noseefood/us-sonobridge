from common import *
import xml.etree.ElementTree as ET
from scipy.optimize import least_squares
folder=WORK/'grid';folder.mkdir(exist_ok=True)
selected=next(r for r in json.loads((WORK/'selection/ranking.json').read_text()) if r['index']==11)
case=selected['case'];patient,cfg=patient_for(case);face0=np.array(selected['face'])
direction=face0[:2,1];direction/=np.linalg.norm(direction)
positions=np.linspace(-16,16,17);rotations=np.linspace(-18,18,13)
def collect():
 rows=[];arrays=[];bad=[]
 for i,mm in enumerate(positions):
  for j,deg in enumerate(rotations):
   xy=np.array(selected['xy'])+direction*mm*.001;spin=selected['spin']+np.deg2rad(deg)
   face,contact,why=patient.project(xy,spin,selected['tilt'])
   if face is None:bad.append((i,j,why));continue
   row,z=view_record(patient,face,xy,spin,selected['tilt'])
   if row['liver_pixels']<5500:bad.append((i,j,'outside liver'));continue
   row.update(index=i*len(rotations)+j,case=case,i=i,j=j,position_mm=float(mm),rotation_deg=float(deg))
   rows.append(row);arrays.append(z)
 return rows,arrays,bad
rows,arrays,bad=collect()
if bad:
 print('Tightening valid sampling range',bad[:5],flush=True)
 positions=np.linspace(-12,12,17);rotations=np.linspace(-12,12,13);rows,arrays,bad=collect()
assert not bad,bad
# Native URDF forward kinematics, and a continuous solution branch.
record=json.loads((APP/f'artifacts/patients/{case}/transforms_fr3.json').read_text())
base=np.array(record['T_world_robot_base']);joints=[];lower=[];upper=[]
for j in ET.parse(APP/'assets/robots/fr3/fr3.urdf').getroot().findall('joint'):
 parent=j.find('parent').get('link');child=j.find('child').get('link')
 if child not in [f'fr3_link{i}' for i in range(9)]:continue
 o=np.eye(4);origin=j.find('origin')
 if origin is not None:o[:3,3]=np.fromstring(origin.get('xyz','0 0 0'),sep=' ');o[:3,:3]=Rotation.from_euler('xyz',np.fromstring(origin.get('rpy','0 0 0'),sep=' ')).as_matrix()
 moving=j.get('type')=='revolute';axis=np.fromstring(j.find('axis').get('xyz'),sep=' ') if j.find('axis') is not None else np.array([0,0,1])
 joints.append(dict(parent=parent,child=child,origin=o.tolist(),axis=axis.tolist(),moving=moving))
 if moving:lower.append(float(j.find('limit').get('lower'))+.02);upper.append(float(j.find('limit').get('upper'))-.02)
q0=np.array(json.loads(Path('/home/xuesong-li/Documents/ChatGPT/写作/SonoBridge_video_v09_case00091/assets/scene.json').read_text())['joints'])
def fk(q):
 out={'base':base};k=0
 for j in joints:
  z=np.eye(4)
  if j['moving']:z[:3,:3]=Rotation.from_rotvec(np.array(j['axis'])*q[k]).as_matrix();k+=1
  out[j['child']]=out[j['parent']]@np.array(j['origin'])@z
 return out
localface=np.array(cfg['probe']['face_origin_source_mm'])*.001
q0=np.clip(q0,np.array(lower)+.00001,np.array(upper)-.00001)
qprev=q0.copy();errors=[]
for row in sorted(rows,key=lambda r:(abs(r['i']-8)+abs(r['j']-6),r['index'])):
 face=np.array(row['face']);goal=face.copy();goal[:3,3]-=goal[:3,:3]@localface
 def err(q):
  f=fk(q)['fr3_link8'];return np.r_[(f[:3,3]-goal[:3,3])*5,Rotation.from_matrix(f[:3,:3].T@goal[:3,:3]).as_rotvec(),(q-qprev)*1e-6,(q-q0)*1e-7]
 q=least_squares(err,qprev,bounds=(lower,upper),max_nfev=350,ftol=1e-11,xtol=1e-11,gtol=1e-11).x;qprev=q
 f=fk(q)['fr3_link8'];actual=f.copy();actual[:3,3]+=actual[:3,:3]@localface
 pe=float(np.linalg.norm(actual[:3,3]-face[:3,3])*1000);ae=float(np.linalg.norm(Rotation.from_matrix(actual[:3,:3].T@face[:3,:3]).as_rotvec()))
 assert pe<.05 and ae<.001,(row['index'],pe,ae)
 row['q']=q.tolist();row['ik_error_mm']=pe;errors.append(pe)
for row,z in zip(rows,arrays):np.savez_compressed(folder/f'input_{row["index"]:03d}.npz',**z)
(folder/'candidates.json').write_text(json.dumps(rows,indent=2))
meta=dict(case_id=case,seed=1042,frequency_mhz=3.4,depth_mm=180,aspect=1.3766881781545433,
 positions=positions.tolist(),rotations=rotations.tolist(),shadows=[-40,-20,0,20,40],details=[0,.25,.5,.75,1],
 defaults=dict(position=8,rotation=6,shadow=2,detail=4),kinematics=dict(base=base.tolist(),joints=joints,face_offset=localface.tolist()),
 probe=cfg['probe'],patient_transform=patient.T_world_ct_mm.tolist(),poses=rows,selected=selected,
 min_central_contact=min(r['central_contact'] for r in rows),min_whole_contact=min(r['whole_contact'] for r in rows),max_ik_error_mm=max(errors))
(WORK/'grid_meta.json').write_text(json.dumps(meta,indent=2))
print('GRID',case,len(rows),'contact',meta['min_central_contact'],meta['min_whole_contact'],'max_ik_mm',max(errors),flush=True)
