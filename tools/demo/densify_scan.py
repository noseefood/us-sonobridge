"""Add native midpoint acquisitions without changing the selected cases or frames."""
from pathlib import Path
import sys,json,time,copy
import numpy as np
organ,command=sys.argv[1:3]
sys.argv=[sys.argv[0],organ,'library']
import refresh_acquisitions as ref
ROOT=ref.ROOT;WORK=ROOT/'refs/demo-build/continuous'/organ;WORK.mkdir(parents=True,exist_ok=True)
OUT=ROOT/'static/demo'/organ
source=ROOT/'refs/demo-build/refresh'/organ

def prepare():
 from scipy.optimize import least_squares
 from scipy.spatial.transform import Rotation
 import xml.etree.ElementTree as ET
 old=json.loads((source/'grid/candidates.json').read_text());meta=json.loads((source/'grid_meta.json').read_text())
 patient,cfg=ref.native.patient_for(meta['case_id']);kin=meta['kinematics'];rows=[];new=[]
 joints=[j for j in ET.parse(ref.APP/'assets/robots/fr3/fr3.urdf').getroot().findall('joint') if j.get('type')=='revolute']
 lo=np.array([float(j.find('limit').get('lower'))+.02 for j in joints]);hi=np.array([float(j.find('limit').get('upper'))-.02 for j in joints])
 def fk(q):
  out=np.array(kin['base']);k=0
  for j in kin['joints']:
   out=out@np.array(j['origin'])
   if j['moving']:
    t=np.eye(4);t[:3,:3]=Rotation.from_rotvec(np.array(j['axis'])*q[k]).as_matrix();out=out@t;k+=1
  out[:3,3]+=out[:3,:3]@np.array(kin['face_offset']);return out
 for i in range(33):
  for j in range(13):
   if i%2==0:r=copy.deepcopy(old[(i//2)*13+j])
   else:
    a,b=old[(i//2)*13+j],old[(i//2+1)*13+j]
    xy=(np.array(a['xy'])+b['xy'])/2;spin=(a['spin']+b['spin'])/2;tilt=(np.array(a['tilt'])+b['tilt'])/2
    candidates=[tilt,np.array(a['tilt']),np.array(b['tilt'])]
    candidates += [tilt+np.deg2rad([dx*d,dy*d]) for d in [1,2,3,4] for dx,dy in [(0,1),(0,-1),(1,0),(-1,0)]]
    valid=[]
    for candidate in candidates:
     face,contact,_=patient.project(xy,spin,candidate)
     if face is not None and contact.center_fraction>=.95 and contact.whole_fraction>=.85:
      valid.append((float(np.linalg.norm(candidate-tilt)),face,contact,candidate))
    assert valid,(organ,i,j,'contact')
    _,face,contact,tilt=min(valid,key=lambda x:x[0])
    if organ=='liver':r,z=ref.native.view_record(patient,face,xy,spin,tilt)
    else:r,z=ref.native.record(patient,face,xy,spin,tilt,i*13+j,meta['case_id'])
    reference=(np.array(a['q'])+b['q'])/2
    def error(q):
     f=fk(q);return np.r_[(f[:3,3]-face[:3,3])*10,Rotation.from_matrix(f[:3,:3].T@face[:3,:3]).as_rotvec(),(q-reference)*1e-6]
    q=least_squares(error,np.clip(reference,lo+1e-5,hi-1e-5),bounds=(lo,hi),max_nfev=400,ftol=1e-11,xtol=1e-11,gtol=1e-11).x
    assert np.linalg.norm(error(q)[:6])<1e-5,(i,j,error(q))
    r['q']=q.tolist();r['ik_error_mm']=float(np.linalg.norm(fk(q)[:3,3]-face[:3,3])*1000)
    np.savez_compressed(WORK/f'input_{i*13+j:03d}.npz',**z)
   r.update(index=i*13+j,i=i,j=j,case=meta['case_id'],position_mm=float(np.interp(i/2,range(17),meta['positions'])))
   rows.append(r)
   if i%2:new.append(r)
  print('Prepared',organ,i+1,'/33',flush=True)
 meta.update(positions=np.linspace(meta['positions'][0],meta['positions'][-1],33).tolist(),poses=rows,defaults={**meta['defaults'],'position':16})
 (WORK/'grid_meta.json').write_text(json.dumps(meta));(WORK/'candidates.json').write_text(json.dumps(new))

def export():
 from PIL import Image,ImageChops
 from scipy import ndimage as ndi
 from runtime import SonoBridge
 from sonogym_convex.control.sonobridge import BridgeSettings
 from sonobridge_core.data.labels import PALETTE
 if organ=='kidney':
  from filled_label import fill_kidney
  from output_refinement import refine_output
 meta=json.loads((WORK/'grid_meta.json').read_text());rows=meta['poses'];cfg=ref.configuration('00091' if organ=='liver' else '00093')
 checkpoint=ref.APP/'sonobridge/weights/sonobridge_liver_3.4MHz_480k.pt' if organ=='liver' else ref.APP/cfg['sonobridge']['checkpoint']
 model=SonoBridge(checkpoint);folder=OUT/'tracks-v4';folder.mkdir(exist_ok=True);start=time.monotonic()
 names=[f'us-{s}-{d}' for s in range(5) for d in range(5)]+['ct','label']+[f'guidance-{s}' for s in range(5)]
 for j in range(13):
  atlases={name:Image.new('RGB',(33*256,256),'black') for name in names}
  # Retain all existing images exactly; only odd slots are new model results.
  for name in names:
   with Image.open(OUT/'tracks'/f'{name}-r{j:02d}.webp') as old:
    for i in range(17):atlases[name].paste(old.crop((i*256,0,(i+1)*256,256)),(i*2*256,0))
  for i in range(1,33,2):
   idx=i*13+j;z=np.load(WORK/f'input_{idx:03d}.npz');us=np.where(z['active'],np.load(WORK/f'us_{idx:03d}.npy'),0).astype(np.uint8)
   labels=fill_kidney(z['labels']) if organ=='kidney' else z['labels']
   for si,shadow in enumerate(meta['shadows']):
    for di,gain in enumerate(meta['details']):
     result=model(us,z['ct_hu'],z['labels'],z['vessels'],BridgeSettings(seed=1042,shadow_area_percent=shadow,structure_gain=gain).to_dict())
     if organ=='kidney':result,_=refine_output(result,labels,True)
     atlases[f'us-{si}-{di}'].paste(Image.fromarray(result).convert('RGB'),(i*256,0))
    maps={k:v.copy() for k,v in model.last_maps.items()};vis=maps['visibility']/255.
    edge=(ndi.binary_dilation(vis>.5)^ndi.binary_erosion(vis>.5))&ndi.binary_erosion(z['valid'],iterations=1)
    enc=np.stack([maps['support'],edge.astype(np.uint8)*255,maps['visibility']],axis=-1)
    atlases[f'guidance-{si}'].paste(Image.fromarray(enc),(i*256,0))
   lab=PALETTE[np.clip(labels,0,15)].copy();lab[~z['valid']]=0;atlases['label'].paste(Image.fromarray(lab),(i*256,0))
   ct=np.rint(np.clip((z['ct_hu']+200)/500,0,1)*255).astype(np.uint8);atlases['ct'].paste(Image.fromarray(ct).convert('RGB'),(i*256,0))
  for name,atlas in atlases.items():
   path=folder/f'{name}-r{j:02d}.webp';atlas.save(path,lossless=True,method=3,exact=True)
   with Image.open(path) as restored:assert ImageChops.difference(atlas,restored.convert('RGB')).getbbox() is None
  print('Exported',organ,j+1,'/13',round(time.monotonic()-start),'s',flush=True)
 old=json.loads((OUT/'manifest-v3.json').read_text());m={**old,'format_version':4,'tracks':'tracks-v4','positions':meta['positions'],'defaults':meta['defaults']}
 m['poses']=[{k:r[k] for k in ['index','i','j','q','face','central_contact','whole_contact']} for r in rows]
 for p in m['poses']:
  if p['i']%2==0:p['shadow_control']=old['poses'][(p['i']//2)*13+p['j']]['shadow_control']
  else:
   a=Image.open(folder/f'us-0-4-r{p["j"]:02d}.webp').crop((p['i']*256,0,(p['i']+1)*256,256))
   b=Image.open(folder/f'us-4-4-r{p["j"]:02d}.webp').crop((p['i']*256,0,(p['i']+1)*256,256));p['shadow_control']=ImageChops.difference(a,b).getbbox() is not None
 (OUT/'manifest-v4.json').write_text(json.dumps(m,separators=(',',':')))
 (WORK/'export-report.json').write_text(json.dumps({'new_native_views':208,'preserved_views':221,'poses':429,'native_outputs':10725,'all_atlases_lossless':True,'seconds':time.monotonic()-start},indent=2))

if command=='prepare':prepare()
elif command=='simulate':ref.simulate(WORK)
elif command=='export':export()
