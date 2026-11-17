"""Choose native views with visible structure and meaningful sweep variation."""
from pathlib import Path
import sys,json,gc
import numpy as np
from scipy import ndimage

organ=sys.argv[1]
if organ=='liver':
 import common as native
 patient_for=native.patient_for
else:
 import kidney_assets as native
 patient_for=native.patient_for
ROOT=Path(__file__).resolve().parents[2]
WORK=ROOT/'refs/demo-build/refresh'/organ
folder=WORK/'selection';folder.mkdir(parents=True,exist_ok=True)

def record(patient,xy,spin,tilt):
 face,contact,_=patient.project(xy,spin,tilt)
 if face is None or contact.center_fraction<.95 or contact.whole_fraction<.85:return None
 if organ=='liver':r,z=native.view_record(patient,face,xy,spin,tilt)
 else:r,z=native.record(patient,face,xy,spin,tilt,0,patient.cfg['data']['case_id'])
 mask=(z['labels']==(4 if organ=='liver' else 2))&z['valid']
 coords=np.argwhere(mask).astype(float)
 if len(coords)<1000:return None
 coords[:,1]*=1.4
 eig=np.linalg.eigvalsh(np.cov(coords.T));r['shape_ratio']=float(np.sqrt(eig[-1]/max(1,eig[0])))
 r['organ_pixels']=int(mask.sum());r['raw_support']=int(z['vessels'].sum())
 return r,z

cases=['00098','00091'] if organ=='liver' else ['00092','00093','00096','00098']
selected=[]
for case in cases:
 patient,cfg=patient_for(case);centers=[]
 if organ=='liver':
  old=json.loads((ROOT/'refs/demo-build/selection/ranking.json').read_text())
  points=[(r['xy'],r['spin'],r['tilt']) for r in old if r['case']==case and r['vessel_pixels']>=700]
 else:
  points=[(patient.initial_xy+np.array([dx,dy])*.001,np.deg2rad(deg),[0,0]) for dx in [-15,0,15] for dy in [-25,0,25] for deg in [30,60,90,120,150]]
 for xy,spin,tilt in points:
  pair=record(patient,xy,spin,tilt)
  if pair and pair[0]['organ_pixels']>=(13000 if organ=='liver' else 2400) and pair[0]['raw_support']>=(650 if organ=='liver' else 100):centers.append(pair)
 centers.sort(key=lambda p:-(p[0]['raw_support']*.8+p[0]['organ_pixels']*.15))
 print(organ,case,'centers',len(centers),flush=True)
 ranked=[]
 for r,z in centers[:12]:
  direction=np.array(r['face'])[:2,1];direction/=np.linalg.norm(direction)
  for span,rotation in ([(20,24),(16,24),(16,18)] if organ=='liver' else [(24,36),(20,30),(18,24)]):
   samples=[]
   for mm in [-span,0,span]:
    for deg in [-rotation,0,rotation]:
     pair=record(patient,np.array(r['xy'])+direction*mm*.001,r['spin']+np.deg2rad(deg),r['tilt'])
     if pair:samples.append(pair[0])
   if len(samples)==9:break
  if len(samples)!=9:continue
  areas=[s['organ_pixels'] for s in samples];ratios=[s['shape_ratio'] for s in samples]
  area_change=(max(areas)-min(areas))/max(areas)
  shape_change=max(ratios)-min(ratios)
  r.update(case=case,span_mm=span,rotation_span_deg=rotation,direction=direction.tolist(),area_change=area_change,shape_change=shape_change,sampled_area_range=[min(areas),max(areas)],sampled_shape_range=[min(ratios),max(ratios)])
  r['score']=r['raw_support']/500+(area_change+shape_change)*2 if organ=='liver' else area_change*6+shape_change*3+min(r['raw_support'],500)/500
  ranked.append((r,z))
 ranked.sort(key=lambda p:-p[0]['score'])
 for r,z in ranked[:4]:
  r['index']=len(selected);np.savez_compressed(folder/f'input_{r["index"]:03d}.npz',**z);selected.append(r)
  print('candidate',r['index'],case,'support',r['raw_support'],'shape',np.round(r['sampled_shape_range'],2),'area',r['sampled_area_range'],'range',r['span_mm'],r['rotation_span_deg'],flush=True)
 del patient;gc.collect()
(folder/'candidates.json').write_text(json.dumps(selected,indent=2))
print('DONE',len(selected),flush=True)
