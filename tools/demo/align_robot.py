"""Choose a consistent redundant-arm posture without changing acquisitions."""
from common import *
from scipy.optimize import least_squares
import xml.etree.ElementTree as ET
meta=json.loads((WORK/'grid_meta.json').read_text());kin=meta['kinematics'];rows=meta['poses']
moving=[j for j in ET.parse(APP/'assets/robots/fr3/fr3.urdf').getroot().findall('joint') if j.get('type')=='revolute']
lo=np.array([float(j.find('limit').get('lower'))+.02 for j in moving]);hi=np.array([float(j.find('limit').get('upper'))-.02 for j in moving])
origins=[np.array(j['origin']) for j in kin['joints']];offset=np.array(kin['face_offset'])
reference=np.deg2rad([-45,-85,45,-155,40,105,145])
def fk(q):
 out=np.array(kin['base']);k=0
 for j,origin in zip(kin['joints'],origins):
  out=out@origin
  if j['moving']:
   z=np.eye(4);z[:3,:3]=Rotation.from_rotvec(np.array(j['axis'])*q[k]).as_matrix();out=out@z;k+=1
 return out
for row in rows:
 face=np.array(row['face']);goal=face.copy();goal[:3,3]-=goal[:3,:3]@offset
 def residual(q):
  f=fk(q)
  return np.r_[(f[:3,3]-goal[:3,3])*10,Rotation.from_matrix(f[:3,:3].T@goal[:3,:3]).as_rotvec(),(q-reference)*1e-4]
 result=least_squares(residual,reference,bounds=(lo,hi),max_nfev=600,ftol=1e-12,xtol=1e-12,gtol=1e-12)
 q=result.x;actual=fk(q);actual[:3,3]+=actual[:3,:3]@offset
 error=float(np.linalg.norm(actual[:3,3]-face[:3,3])*1000)
 assert error<.01,(row['index'],error)
 row['q']=q.tolist();row['ik_error_mm']=error
changes=[]
for p in rows:
 for other in [p['index']+1 if p['j']<12 else None,p['index']+13 if p['i']<16 else None]:
  if other is not None:changes.append(float(np.max(np.abs(np.array(p['q'])-rows[other]['q']))*180/np.pi))
assert max(changes)<7, max(changes)
meta['max_ik_error_mm']=max(r['ik_error_mm'] for r in rows)
meta['max_adjacent_joint_change_deg']=max(changes)
(WORK/'grid_meta.json').write_text(json.dumps(meta,indent=2))
(WORK/'grid/candidates.json').write_text(json.dumps(rows,indent=2))
manifest=json.loads((OUT/'manifest.json').read_text())
for p,r in zip(manifest['poses'],rows):p['q']=r['q']
(OUT/'manifest.json').write_text(json.dumps(manifest,separators=(',',':')))
print('Aligned',len(rows),'poses; maximum adjacent joint change',max(changes),'degrees; maximum tip error',meta['max_ik_error_mm'],'mm',flush=True)
