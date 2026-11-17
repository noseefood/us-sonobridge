"""Native kidney acquisitions and frozen inference; never alters SonoGym inputs."""
from pathlib import Path
import sys,json,gc,time
sys.dont_write_bytecode=True
import numpy as np,yaml
from scipy.spatial.transform import Rotation
ROOT=Path(__file__).resolve().parents[2];WORK=ROOT/'refs/demo-build/kidney';WORK.mkdir(parents=True,exist_ok=True)
OUT=ROOT/'static/demo/kidney';OUT.mkdir(parents=True,exist_ok=True)
APP=Path('/home/xuesong-li/Research_IFL/CT-MRI2US/SonoGym/apps/sonobridge_kidney')
sys.path[:0]=[str(APP),str(APP/'sonobridge'),str(APP.parents[1]/'packages')]
def config(case):
 c=yaml.safe_load((APP/'config/scene.yaml').read_text());c['data'].update(case_id=case,patient_dir=f'assets/patients/{case}',derived_dir=f'artifacts/patients/{case}',volume_cache=f'artifacts/patients/{case}/patient.npz',split_manifest=f'assets/patients/{case}/split_manifest.json');c['control']['slice_size']=[256,256]
 if case=='00098':
  source=WORK/'patient-00098';c['data'].update(patient_dir=str(source),derived_dir=str(source),volume_cache=str(source/'patient.npz'))
 return c
def patient_for(case):
 from sonogym_convex.data import initial_pose
 initial_pose.select_kidney_start=lambda p:None
 from sonogym_convex.data.patient import Patient
 c=config(case);return Patient(c),c

def record(patient,face,xy,spin,tilt,index,case):
 obs=patient.observation(face,face);contact=patient.contact(face)
 native=patient.T_ct_mm_world@np.r_[face[:3,3],1]
 rotation=patient.T_ct_mm_world[:3,:3]*.001@face[:3,:3]
 row=dict(index=index,case=case,face=face.tolist(),xy=list(xy),spin=float(spin),tilt=list(tilt),native_position=native[:3].tolist(),native_angles=Rotation.from_matrix(rotation).as_euler('xyz').tolist(),central_contact=contact.center_fraction,whole_contact=contact.whole_fraction,kidney_pixels=int(((obs.labels==2)&obs.valid_mask).sum()),support_pixels=int(obs.kidney_medulla.sum()))
 arrays=dict(ct_hu=obs.ct_hu,labels=obs.labels,vessels=obs.kidney_medulla,valid=obs.valid_mask,active=obs.display_contact_lines[patient.canvas_lines]&obs.valid_mask)
 return row,arrays

def select():
 dest=WORK/'selection';dest.mkdir(exist_ok=True);case='00098';patient,cfg=patient_for(case);rows=[];candidates=[]
 center=patient.initial_xy.copy();checked=0
 for dx in [-20,-10,0,10,20]:
  for dy in [-30,-15,0,15,30]:
   xy=center+np.array([dx,dy])*.001
   for deg in [60,90,120,150]:
    for tilt in [[0,0],[0,np.deg2rad(10)]]:
     face,contact,_=patient.project(xy,np.deg2rad(deg),tilt);checked+=1
     if face is None or contact.center_fraction<.95 or contact.whole_fraction<.88:continue
     r,z=record(patient,face,xy,np.deg2rad(deg),tilt,0,case)
     if r['kidney_pixels']>=3000:candidates.append((r,z))
   if checked%40==0:print('Checked',checked,'valid',len(candidates),flush=True)
 candidates.sort(key=lambda pair:-pair[0]['kidney_pixels'])
 for r,z in candidates:
  if any(np.linalg.norm(np.array(r['xy'])-q['xy'])<.012 and abs(r['spin']-q['spin'])<.3 for q in rows):continue
  r['index']=len(rows);np.savez_compressed(dest/f'input_{r["index"]:03d}.npz',**z);rows.append(r)
  if len(rows)==12:break
 (dest/'candidates.json').write_text(json.dumps(rows,indent=2));print('Selected',len(rows),'case 00098',flush=True)

def grid(chosen):
 from scipy.optimize import least_squares
 import xml.etree.ElementTree as ET
 selected=json.loads((WORK/'selection/candidates.json').read_text())[chosen];case=selected['case'];patient,cfg=patient_for(case);base_meta=json.loads((ROOT/'refs/demo-build/grid_meta.json').read_text());kin=base_meta['kinematics']
 face0=np.array(selected['face']);direction=face0[:2,1];direction/=np.linalg.norm(direction)
 dest=WORK/'grid';dest.mkdir(exist_ok=True)
 for span in [12,10,8,6]:
  positions=np.linspace(-span,span,17);rotations=np.linspace(-12,12,13);rows=[];arrays=[];bad=[]
  for i,mm in enumerate(positions):
   for j,deg in enumerate(rotations):
    xy=np.array(selected['xy'])+direction*mm*.001;spin=selected['spin']+np.deg2rad(deg)
    face,contact,why=patient.project(xy,spin,selected['tilt'])
    if face is None or contact.center_fraction<.95 or contact.whole_fraction<.85:bad.append((i,j,why));continue
    r,z=record(patient,face,xy,spin,selected['tilt'],i*13+j,case)
    if r['kidney_pixels']<2800:bad.append((i,j,'small kidney'));continue
    r.update(i=i,j=j,position_mm=float(mm),rotation_deg=float(deg));rows.append(r);arrays.append(z)
  if not bad:break
  print('Range',span,'invalid',len(bad),bad[:3],flush=True)
 assert not bad,bad
 joints=[j for j in ET.parse(APP/'assets/robots/fr3/fr3.urdf').getroot().findall('joint') if j.get('type')=='revolute'];lo=[float(j.find('limit').get('lower'))+.02 for j in joints];hi=[float(j.find('limit').get('upper'))-.02 for j in joints]
 reference=np.deg2rad([-45,-85,45,-155,40,105,145]);offset=np.array(kin['face_offset']);origins=[np.array(j['origin']) for j in kin['joints']]
 def fk(q):
  out=np.array(kin['base']);k=0
  for j,o in zip(kin['joints'],origins):
   out=out@o
   if j['moving']:
    z=np.eye(4);z[:3,:3]=Rotation.from_rotvec(np.array(j['axis'])*q[k]).as_matrix();out=out@z;k+=1
  return out
 # Solve the kidney orientation on its own continuous branch, preserving FK.
 face=np.array(rows[110]['face']);goal=face.copy();goal[:3,3]-=goal[:3,:3]@offset
 rng=np.random.default_rng(1042);solutions=[]
 seeds=[reference,np.deg2rad([-45,-60,20,-140,20,100,-40]),np.deg2rad([0,-30,0,-110,0,90,40])]+[rng.uniform(lo,hi) for _ in range(24)]
 for seed in seeds:
  def center_err(q):
   f=fk(q);return np.r_[(f[:3,3]-goal[:3,3])*10,Rotation.from_matrix(f[:3,:3].T@goal[:3,:3]).as_rotvec(),(q-seed)*1e-6]
  q=least_squares(center_err,np.clip(seed,np.array(lo)+1e-5,np.array(hi)-1e-5),bounds=(lo,hi),max_nfev=450,ftol=1e-11,xtol=1e-11,gtol=1e-11).x
  e=center_err(q)[:6]
  if np.linalg.norm(e)<1e-5:
   # Prefer an upright elbow, away from the patient, within joint limits.
   world=np.array(kin['base']);jidx=0;heights=[]
   for j,o in zip(kin['joints'],origins):
    world=world@o
    if j['moving']:
     z=np.eye(4);z[:3,:3]=Rotation.from_rotvec(np.array(j['axis'])*q[jidx]).as_matrix();world=world@z;jidx+=1
    heights.append(world[2,3])
   score=max(0,1.04-heights[4])*100+np.linalg.norm(q-np.deg2rad([-30,-60,0,-140,20,90,0]))*.03
   solutions.append((score,q))
 assert solutions,'No reachable FR3 center pose'
 reference=min(solutions,key=lambda x:x[0])[1];print('Kidney IK reference',np.rad2deg(reference).round(2).tolist(),len(solutions),'solutions',flush=True)
 for r in rows:
  face=np.array(r['face']);goal=face.copy();goal[:3,3]-=goal[:3,:3]@offset
  def err(q):
   f=fk(q);return np.r_[(f[:3,3]-goal[:3,3])*10,Rotation.from_matrix(f[:3,:3].T@goal[:3,:3]).as_rotvec(),(q-reference)*1e-4]
  q=least_squares(err,reference,bounds=(lo,hi),max_nfev=700,ftol=1e-12,xtol=1e-12,gtol=1e-12).x
  f=fk(q);f[:3,3]+=f[:3,:3]@offset;pe=np.linalg.norm(f[:3,3]-face[:3,3])*1000;ae=np.linalg.norm(Rotation.from_matrix(f[:3,:3].T@face[:3,:3]).as_rotvec());assert pe<.01 and ae<.001,(r['index'],pe,ae)
  r.update(q=q.tolist(),ik_error_mm=float(pe))
 changes=[max(abs(np.array(p['q'])-rows[n]['q'])) for p in rows for n in [p['index']+1 if p['j']<12 else None,p['index']+13 if p['i']<16 else None] if n is not None];assert np.rad2deg(max(changes))<8,np.rad2deg(max(changes))
 for r,z in zip(rows,arrays):np.savez_compressed(dest/f'input_{r["index"]:03d}.npz',**z)
 (dest/'candidates.json').write_text(json.dumps(rows,indent=2))
 R=cfg['probe']['radius_mm'];far=R+cfg['probe']['depth_mm'];half=np.deg2rad(cfg['probe']['sector_angle_deg']/2)
 meta=dict(organ='kidney',case_id=case,seed=1042,frequency_mhz=3.,depth_mm=160,aspect=2*far*np.sin(half)/(far-R*np.cos(half)),positions=positions.tolist(),rotations=rotations.tolist(),shadows=[-40,-20,0,20,40],details=[0,.25,.5,.75,1],defaults=dict(position=1,rotation=1,shadow=2,detail=4),kinematics=kin,probe=cfg['probe'],patient_transform=patient.T_world_ct_mm.tolist(),poses=rows,selected=selected,max_adjacent_joint_change_deg=float(np.rad2deg(max(changes))),model_checkpoint=cfg['sonobridge']['checkpoint'],output_postprocessing='native kidney demo: local_outward_tissue_transport_v2')
 (WORK/'grid_meta.json').write_text(json.dumps(meta,indent=2));print('GRID',case,len(rows),'maxjoint',meta['max_adjacent_joint_change_deg'],flush=True)

def outputs(preview=False):
 from PIL import Image,ImageChops,ImageDraw
 from scipy import ndimage as ndi
 from runtime import SonoBridge
 from filled_label import fill_kidney
 from output_refinement import refine_output
 from sonogym_convex.control.sonobridge import BridgeSettings
 from sonobridge_core.data.labels import PALETTE
 folder=WORK/('selection' if preview else 'grid');rows=json.loads((folder/'candidates.json').read_text());cfg=config(rows[0]['case']);model=SonoBridge(APP/cfg['sonobridge']['checkpoint']);reports=[];start=time.monotonic();thumbs=[]
 for r in rows:
  idx=r['index'];dest=OUT/'frames'/f'{idx:03d}'
  expected=[f'us-{s}-{d}.webp' for s in range(5) for d in range(5)]+['label.webp','ct.webp']+[f'guidance-{s}.webp' for s in range(5)]
  if not preview and '--resume' in sys.argv and all((dest/name).is_file() for name in expected):
   reports.append(dict(index=idx,status='completed and lossless-verified in preceding export run'));continue
  z=np.load(folder/f'input_{idx:03d}.npz');us=np.where(z['active'],np.load(folder/f'us_{idx:03d}.npy'),0).astype(np.uint8);labels=fill_kidney(z['labels'])
  if not preview:dest.mkdir(parents=True,exist_ok=True)
  for si,shadow in ([(2,0)] if preview else enumerate([-40,-20,0,20,40])):
   for di,gain in ([(4,1)] if preview else enumerate([0,.25,.5,.75,1])):
    raw=model(us,z['ct_hu'],z['labels'],z['vessels'],BridgeSettings(seed=1042,shadow_area_percent=shadow,structure_gain=gain).to_dict())
    result,post=refine_output(raw,labels,True)
    if preview:
     Image.fromarray(result).save(folder/f'output_{idx:03d}.png');thumbs.append((r,result))
    else:
     p=dest/f'us-{si}-{di}.webp';Image.fromarray(result).save(p,lossless=True,method=3)
     assert np.array_equal(np.array(Image.open(p).convert('RGB')),np.repeat(result[...,None],3,axis=-1))
   maps=model.last_maps;vis=maps['visibility']/255.;edge=(ndi.binary_dilation(vis>.5)^ndi.binary_erosion(vis>.5))&ndi.binary_erosion(z['valid'],iterations=1)
   enc=np.stack([maps['support'],edge.astype(np.uint8)*255,maps['visibility']],axis=-1)
   if not preview:Image.fromarray(enc).save(dest/f'guidance-{si}.webp',lossless=True,method=4)
  if not preview:
   lab=PALETTE[np.clip(labels,0,15)].copy();lab[~z['valid']]=0;Image.fromarray(lab).save(dest/'label.webp',lossless=True,method=4)
   ct=np.rint(np.clip((z['ct_hu']+200)/500,0,1)*255).astype(np.uint8);Image.fromarray(ct).save(dest/'ct.webp',lossless=True,method=4)
  reports.append(dict(index=idx,diagnostics=model.last_diagnostics,postprocess=post))
  if not preview:(WORK/'export-progress.json').write_text(json.dumps(reports,indent=2))
  if len(reports)%20==0 or preview:print('Kidney outputs',len(reports),'/',len(rows),'elapsed',round(time.monotonic()-start),flush=True)
 if preview:
  sheet=Image.new('RGB',(4*350,3*305),'#20282d');d=ImageDraw.Draw(sheet)
  for k,(r,im) in enumerate(thumbs):
   x=(k%4)*350;y=(k//4)*305;sheet.paste(Image.fromarray(im).resize((340,250)),(x+5,y+28));d.text((x+10,y+8),f"{r['index']} | {r['case']} | kidney {r['kidney_pixels']}",fill='white')
  sheet.save(WORK/'selection-preview.jpg')
 else:
  meta=json.loads((WORK/'grid_meta.json').read_text());manifest={k:meta[k] for k in ['organ','case_id','seed','frequency_mhz','depth_mm','aspect','positions','rotations','shadows','details','defaults','kinematics','probe']};manifest['poses']=[{k:r[k] for k in ['index','i','j','q','face','central_contact','whole_contact']} for r in rows];manifest.update(format_version=2,anatomy='anatomy.compact.glb',image_layout='individual-lossless-webp')
  (OUT/'manifest.json').write_text(json.dumps(manifest,separators=(',',':')))
 (WORK/('preview_report.json' if preview else 'image_export.json')).write_text(json.dumps(dict(poses=len(rows),outputs=len(rows)*(1 if preview else 25),checkpoint=cfg['sonobridge']['checkpoint'],elapsed_s=time.monotonic()-start,pixel_export='lossless verified against native pipeline output',records=reports),indent=2))

if __name__=='__main__':
 command=sys.argv[1]
 if command=='select':select()
 elif command=='grid':grid(int(sys.argv[2]))
 else:outputs(command=='preview')
