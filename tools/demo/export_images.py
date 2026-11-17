from common import *
from PIL import Image
from scipy import ndimage as ndi
from concurrent.futures import ThreadPoolExecutor
from runtime import SonoBridge
from sonogym_convex.control.sonobridge import BridgeSettings
from sonobridge_core.data.labels import PALETTE
import time,hashlib
folder=WORK/'grid';meta=json.loads((WORK/'grid_meta.json').read_text());rows=meta['poses']
dest=OUT/'atlases';dest.mkdir(exist_ok=True)
model=SonoBridge(APP/'sonobridge/weights/sonobridge_liver_3.4MHz_480k.pt')
manifest={k:meta[k] for k in ['case_id','seed','frequency_mhz','depth_mm','aspect','positions','rotations','shadows','details','defaults','kinematics','probe']}
manifest['poses']=[{k:r[k] for k in ['index','i','j','q','face','central_contact','whole_contact']} for r in rows]
manifest.update(tile_size=256,atlas_columns=5,atlas_rows=7,format_version=1,anatomy='scene.glb')
(OUT/'manifest.json').write_text(json.dumps(manifest,separators=(',',':')))
pool=ThreadPoolExecutor(max_workers=3);futures=[];report=[];start=time.monotonic()
def save(index,canvas):
 path=dest/f'{index:03d}.webp';tmp=path.with_suffix('.tmp.webp');canvas.save(tmp,format='WEBP',lossless=True,method=3);tmp.replace(path)
 # A sampled proof that compressed display pixels are still model outputs.
 if index in [0,110,220]:assert np.array_equal(np.array(Image.open(path)),np.array(canvas))
 return path.stat().st_size
for r in sorted(rows,key=lambda r:abs(r['i']-8)+abs(r['j']-6)):
 i=r['index'];z=np.load(folder/f'input_{i:03d}.npz');us=np.where(z['active'],np.load(folder/f'us_{i:03d}.npy'),0).astype(np.uint8)
 args=[us,z['ct_hu'],z['labels'],z['vessels']];atlas=Image.new('RGB',(1280,1792),'black');defaults=None;diagnostics=[]
 for si,shadow in enumerate(meta['shadows']):
  for gi,gain in enumerate(meta['details']):
   settings=BridgeSettings(seed=meta['seed'],shadow_area_percent=shadow,structure_gain=gain)
   result=model(*args,settings.to_dict());atlas.paste(Image.fromarray(result).convert('RGB'),(gi*256,si*256))
   if si==2 and gi==4:defaults=result.copy();np.save(folder/f'default_{i:03d}.npy',result)
  maps=model.last_maps;vis=maps['visibility']/255.;boundary=(ndi.binary_dilation(vis>.5)^ndi.binary_erosion(vis>.5))&ndi.binary_erosion(z['valid'],iterations=1)
  # RGB encodes support and visibility boundary for a transparent UI overlay.
  enc=np.zeros((256,256,3),np.uint8);enc[:,:,0]=maps['support'];enc[:,:,1]=boundary.astype(np.uint8)*255;enc[:,:,2]=np.rint(vis*255).astype(np.uint8)
  atlas.paste(Image.fromarray(enc),(si*256,6*256));diagnostics.append(dict(model.last_diagnostics))
 atlas.paste(Image.fromarray(us).convert('RGB'),(0,5*256))
 lab=PALETTE[np.clip(z['labels'],0,15)].copy();lab[~z['valid']]=0;atlas.paste(Image.fromarray(lab),(256,5*256))
 ct=np.rint(np.clip((z['ct_hu']+200)/500,0,1)*255).astype(np.uint8);atlas.paste(Image.fromarray(ct).convert('RGB'),(512,5*256))
 atlas.paste(Image.fromarray(z['valid'].astype(np.uint8)*255).convert('RGB'),(768,5*256))
 if i==110:
  Image.fromarray(defaults).save(OUT/'default.png');Image.fromarray(us).save(OUT/'simulated.png')
 futures.append(pool.submit(save,i,atlas));report.append(dict(index=i,diagnostics=diagnostics))
 if len(report)%10==0 or len(report)==1:print('Exported',len(report),'/',len(rows),'elapsed',round(time.monotonic()-start,1),flush=True)
sizes=[f.result() for f in futures];pool.shutdown()
(WORK/'image_export.json').write_text(json.dumps(dict(case=meta['case_id'],poses=len(rows),model_outputs=len(rows)*25,bytes=sum(sizes),median_atlas_bytes=int(np.median(sizes)),elapsed_seconds=time.monotonic()-start,lossless=True,records=report),indent=2))
print('COMPLETE',len(rows)*25,'outputs',round(sum(sizes)/1e6,1),'MB',flush=True)
