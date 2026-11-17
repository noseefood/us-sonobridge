"""Generate native acquisitions and lossless sweep atlases for the static demo."""
from pathlib import Path
import sys,json,gc,time
sys.dont_write_bytecode=True
import numpy as np
from scipy.spatial.transform import Rotation
organ,command=sys.argv[1:3]
if organ=='liver':
 import common as native
else:
 import kidney_assets as native
ROOT=Path(__file__).resolve().parents[2];WORK=ROOT/'refs/demo-build/refresh'/organ
APP=native.APP;OUT=ROOT/'static/demo'/organ
configuration=native.configuration if organ=='liver' else native.config

def simulate(folder):
 rows=json.loads((folder/'candidates.json').read_text());cfg=configuration(rows[0]['case']);rc=cfg['raytracing'];pc=cfg['probe']
 sys.path.insert(0,str(APP/'vendor'));import raysim.cuda as rs
 for case in sorted(set(r['case'] for r in rows)):
  materials=rs.Materials();world=rs.World('muscle')
  meshdir=ROOT/'refs/demo-build/kidney/patient-00098/meshes' if organ=='kidney' and case=='00098' else APP/f'assets/patients/{case}/meshes'
  for path in sorted(meshdir.glob('*.obj')):world.add(rs.Mesh(str(path),materials.get_index(rc['material_lut'].get(path.stem,'air'))))
  sim=rs.RaytracingUltrasoundSimulator(world,materials)
  probe=rs.CurvilinearProbe(rs.Pose(np.zeros(3,np.float32),np.zeros(3,np.float32)),num_elements_x=pc['num_scanlines'],sector_angle=pc['sector_angle_deg'],radius=pc['radius_mm'],frequency=3.4 if organ=='liver' else 3.,elevational_height=pc['elevation_width_mm'],num_el_samples=rc['elevation_samples'])
  params=rs.SimParams();params.conv_psf=True;params.buffer_size=rc['buffer_size'];params.t_far=pc['depth_mm'];params.enable_cuda_timing=False;params.median_clip_filter=rc['median_clip_filter'];params.contact_epsilon=rc['contact_epsilon_mm'];params.b_mode_size=(256,256)
  for r in rows:
   if r['case']!=case:continue
   probe.set_pose(rs.Pose(np.array(r['native_position'],np.float32),np.array(r['native_angles'],np.float32)));bmode=np.asarray(sim.simulate(probe,params));lo,hi=rc['b_mode_db_range'];np.save(folder/f'us_{r["index"]:03d}.npy',(np.clip((bmode-lo)/(hi-lo),0,1)*255).astype(np.uint8))
  print('Simulated',organ,case,flush=True);del sim,probe,world,materials;gc.collect()

def grid(chosen):
 from scipy.optimize import least_squares
 import xml.etree.ElementTree as ET
 selected=json.loads((WORK/'selection/candidates.json').read_text())[chosen];case=selected['case'];patient,cfg=native.patient_for(case)
 original=ROOT/('static/demo/manifest.json' if organ=='liver' else 'static/demo/kidney/manifest.json')
 if not original.exists():original=OUT/'manifest-v3.json'
 old=json.loads(original.read_text());kin=old['kinematics']
 positions=np.linspace(-selected['span_mm'],selected['span_mm'],17);rotations=np.linspace(-selected['rotation_span_deg'],selected['rotation_span_deg'],13)
 rows=[];arrays=[];bad=[];folder=WORK/'grid';folder.mkdir(exist_ok=True)
 for i,mm in enumerate(positions):
  for j,deg in enumerate(rotations):
   xy=np.array(selected['xy'])+np.array(selected['direction'])*mm*.001;spin=selected['spin']+np.deg2rad(deg)
   tilt=np.array(selected['tilt'],float);face,contact,why=patient.project(xy,spin,tilt)
   # Small native tilt adjustments keep every sampled probe coupled to skin.
   # The adjusted physical pose is used for CT slicing, simulation and FK.
   if face is None or contact.center_fraction<.95 or contact.whole_fraction<.85:
    for radius in [2,4,6]:
     accepted=None
     for dx,dy in [(0,1),(0,-1),(1,0),(-1,0),(1,1),(-1,1),(1,-1),(-1,-1)]:
      trial=np.array(selected['tilt'])+np.deg2rad([dx*radius,dy*radius]);f,c,w=patient.project(xy,spin,trial)
      if f is not None and c.center_fraction>=.95 and c.whole_fraction>=.85:
       accepted=(f,c,w,trial);break
     if accepted:face,contact,why,tilt=accepted;break
   if face is None or contact.center_fraction<.95 or contact.whole_fraction<.85:bad.append((i,j,why));continue
   if organ=='liver':r,z=native.view_record(patient,face,xy,spin,tilt)
   else:r,z=native.record(patient,face,xy,spin,tilt,i*13+j,case)
   count=int(((z['labels']==(4 if organ=='liver' else 2))&z['valid']).sum())
   if count<(5000 if organ=='liver' else 1000):bad.append((i,j,'organ too small'));continue
   r.update(index=i*13+j,case=case,i=i,j=j,position_mm=float(mm),rotation_deg=float(deg));rows.append(r);arrays.append(z)
 assert not bad,bad
 joints=[j for j in ET.parse(APP/'assets/robots/fr3/fr3.urdf').getroot().findall('joint') if j.get('type')=='revolute'];lo=np.array([float(j.find('limit').get('lower'))+.02 for j in joints]);hi=np.array([float(j.find('limit').get('upper'))-.02 for j in joints])
 origins=[np.array(j['origin']) for j in kin['joints']];offset=np.array(kin['face_offset']);reference=np.array(old['poses'][110]['q'])
 def fk(q):
  out=np.array(kin['base']);k=0
  for j,o in zip(kin['joints'],origins):
   out=out@o
   if j['moving']:
    z=np.eye(4);z[:3,:3]=Rotation.from_rotvec(np.array(j['axis'])*q[k]).as_matrix();out=out@z;k+=1
  return out
 solved={};remaining=sorted(rows,key=lambda r:abs(r['i']-8)+abs(r['j']-6));rng=np.random.default_rng(1042)
 for r in remaining:
  face=np.array(r['face']);goal=face.copy();goal[:3,3]-=goal[:3,:3]@offset
  if solved:reference=np.array(min(solved.values(),key=lambda q:abs(q['i']-r['i'])+abs(q['j']-r['j']))['q'])
  def err(q):
   f=fk(q);return np.r_[(f[:3,3]-goal[:3,3])*10,Rotation.from_matrix(f[:3,:3].T@goal[:3,:3]).as_rotvec(),(q-reference)*1e-6]
  q=least_squares(err,np.clip(reference,lo+1e-5,hi-1e-5),bounds=(lo,hi),max_nfev=500,ftol=1e-11,xtol=1e-11,gtol=1e-11).x
  if np.linalg.norm(err(q)[:6])>1e-5 and not solved:
   for _ in range(30):
    q=least_squares(err,rng.uniform(lo,hi),bounds=(lo,hi),max_nfev=500,ftol=1e-11,xtol=1e-11,gtol=1e-11).x
    if np.linalg.norm(err(q)[:6])<1e-5:break
  f=fk(q);f[:3,3]+=f[:3,:3]@offset;pe=np.linalg.norm(f[:3,3]-face[:3,3])*1000;ae=np.linalg.norm(Rotation.from_matrix(f[:3,:3].T@face[:3,:3]).as_rotvec());assert pe<.01 and ae<.001,(r['index'],pe,ae)
  r.update(q=q.tolist(),ik_error_mm=float(pe));solved[r['index']]=r
 changes=[max(abs(np.array(p['q'])-rows[n]['q'])) for p in rows for n in [p['index']+1 if p['j']<12 else None,p['index']+13 if p['i']<16 else None] if n is not None]
 assert np.rad2deg(max(changes))<12,np.rad2deg(max(changes))
 for r,z in zip(rows,arrays):np.savez_compressed(folder/f'input_{r["index"]:03d}.npz',**z)
 (folder/'candidates.json').write_text(json.dumps(rows,indent=2))
 pc=cfg['probe'];R=pc['radius_mm'];far=R+pc['depth_mm'];half=np.deg2rad(pc['sector_angle_deg']/2)
 meta=dict(organ=organ,case_id=case,seed=1042,frequency_mhz=3.4 if organ=='liver' else 3.,depth_mm=pc['depth_mm'],aspect=2*far*np.sin(half)/(far-R*np.cos(half)),positions=positions.tolist(),rotations=rotations.tolist(),shadows=[-40,-20,0,20,40],details=[0,.25,.5,.75,1],defaults=dict(position=8,rotation=6,shadow=2,detail=4),kinematics=kin,probe=pc,patient_transform=patient.T_world_ct_mm.tolist(),poses=rows,selected=selected,max_adjacent_joint_change_deg=float(np.rad2deg(max(changes))))
 (WORK/'grid_meta.json').write_text(json.dumps(meta,indent=2));print('GRID',organ,case,len(rows),'maxjoint',meta['max_adjacent_joint_change_deg'],flush=True)

def inference(preview):
 from PIL import Image,ImageDraw,ImageChops
 from scipy import ndimage as ndi
 from runtime import SonoBridge
 from sonogym_convex.control.sonobridge import BridgeSettings
 from sonobridge_core.data.labels import PALETTE
 if organ=='kidney':
  from filled_label import fill_kidney
  from output_refinement import refine_output
 cfg=configuration('00091' if organ=='liver' else '00093')
 checkpoint=APP/'sonobridge/weights/sonobridge_liver_3.4MHz_480k.pt' if organ=='liver' else APP/cfg['sonobridge']['checkpoint']
 model=SonoBridge(checkpoint);folder=WORK/('selection' if preview else 'grid');rows=json.loads((folder/'candidates.json').read_text());start=time.monotonic();reports=[]
 if not preview:
  OUT.mkdir(exist_ok=True);(OUT/'tracks').mkdir(exist_ok=True);meta=json.loads((WORK/'grid_meta.json').read_text())
 groups=[rows] if preview else [[r for r in rows if r['j']==j] for j in range(13)]
 thumbs=[]
 for group in groups:
  atlases={name:Image.new('RGB',(17*256,256),'black') for name in ([f'us-{s}-{d}' for s in range(5) for d in range(5)]+['ct','label']+[f'guidance-{s}' for s in range(5)])} if not preview else {}
  for r in group:
   idx=r['index'];z=np.load(folder/f'input_{idx:03d}.npz');us=np.where(z['active'],np.load(folder/f'us_{idx:03d}.npy'),0).astype(np.uint8);labels=fill_kidney(z['labels']) if organ=='kidney' else z['labels'];outputs=[];diags=[]
   for si,shadow in ([(2,0)] if preview else enumerate([-40,-20,0,20,40])):
    for di,gain in ([(4,1),(0,0)] if preview else enumerate([0,.25,.5,.75,1])):
     result=model(us,z['ct_hu'],z['labels'],z['vessels'],BridgeSettings(seed=1042,shadow_area_percent=shadow,structure_gain=gain).to_dict())
     if organ=='kidney':result,_=refine_output(result,labels,True)
     if preview:
      Image.fromarray(result).save(folder/f'output_{idx:03d}_{di}.png');outputs.append(result)
     else:
      atlases[f'us-{si}-{di}'].paste(Image.fromarray(result).convert('RGB'),(r['i']*256,0))
      if idx==110 and si==2 and di==4:Image.fromarray(result).save(OUT/'preview.webp',lossless=True,method=4)
     if di==4:maps={k:v.copy() for k,v in model.last_maps.items()};diag=dict(model.last_diagnostics)
    diags.append(diag);vis=maps['visibility']/255.;edge=(ndi.binary_dilation(vis>.5)^ndi.binary_erosion(vis>.5))&ndi.binary_erosion(z['valid'],iterations=1);enc=np.stack([maps['support'],edge.astype(np.uint8)*255,maps['visibility']],axis=-1)
    if not preview:atlases[f'guidance-{si}'].paste(Image.fromarray(enc),(r['i']*256,0))
   if preview:
    thumbs.append((r,outputs,diag));print('Preview',idx,r['case'],'support',diag.get('support_pixels'),'shape',r['sampled_shape_range'],flush=True)
   else:
    lab=PALETTE[np.clip(labels,0,15)].copy();lab[~z['valid']]=0;atlases['label'].paste(Image.fromarray(lab),(r['i']*256,0));ct=np.rint(np.clip((z['ct_hu']+200)/500,0,1)*255).astype(np.uint8);atlases['ct'].paste(Image.fromarray(ct).convert('RGB'),(r['i']*256,0))
    reports.append(dict(index=idx,diagnostics=diags))
  if not preview:
   j=group[0]['j']
   for name,atlas in atlases.items():
    path=OUT/'tracks'/f'{name}-r{j:02d}.webp';atlas.save(path,lossless=True,method=3,exact=True)
    with Image.open(path) as restored:assert ImageChops.difference(atlas,restored.convert('RGB')).getbbox() is None
   print('Exported',organ,j+1,'/13 tracks',round(time.monotonic()-start),'s',flush=True)
 if preview:
  sheet=Image.new('RGB',(1024,len(thumbs)*205),'#20292e');draw=ImageDraw.Draw(sheet)
  for k,(r,outs,diag) in enumerate(thumbs):
   text=f"{r['index']} / {r['case']}  support {diag.get('support_pixels')}  span {r['span_mm']}mm / {r['rotation_span_deg']}deg"
   draw.text((12,k*205+8),text,fill='white')
   for j,img in enumerate(outs):sheet.paste(Image.fromarray(img).resize((330,170)),(j*340,k*205+28))
   z=np.load(folder/f'input_{r["index"]:03d}.npz');lab=PALETTE[np.clip(z['labels'],0,15)].copy();lab[z['vessels']>0]=[245,190,75];sheet.paste(Image.fromarray(lab).resize((330,170)),(680,k*205+28))
  sheet.save(WORK/'selection-preview.jpg')
 else:
  manifest={k:meta[k] for k in ['organ','case_id','seed','frequency_mhz','depth_mm','aspect','positions','rotations','shadows','details','defaults','kinematics','probe']}
  manifest.update(format_version=3,image_layout='lossless-position-tracks',tile_size=256,preview='preview.webp',anatomy=f'anatomy-{meta["case_id"]}.compact.glb')
  manifest['poses']=[{k:r[k] for k in ['index','i','j','q','face','central_contact','whole_contact']} for r in rows]
  for p in manifest['poses']:
   a=Image.open(OUT/'tracks'/f'us-0-4-r{p["j"]:02d}.webp').crop((p['i']*256,0,(p['i']+1)*256,256));b=Image.open(OUT/'tracks'/f'us-4-4-r{p["j"]:02d}.webp').crop((p['i']*256,0,(p['i']+1)*256,256));p['shadow_control']=ImageChops.difference(a,b).getbbox() is not None
  (OUT/'manifest-v3.json').write_text(json.dumps(manifest,separators=(',',':')))
  (WORK/'image-export.json').write_text(json.dumps(dict(poses=len(rows),outputs=len(rows)*25,elapsed_seconds=time.monotonic()-start,pixel_export='all lossless atlases verified against native output',records=reports),indent=2))

if command=='simulate':simulate(WORK/sys.argv[3])
elif command=='grid':grid(int(sys.argv[3]))
elif command in ('preview','export'):inference(command=='preview')
