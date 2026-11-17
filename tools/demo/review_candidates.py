from common import *
from PIL import Image,ImageDraw
from scipy import ndimage as ndi
from runtime import SonoBridge
from sonogym_convex.control.sonobridge import BridgeSettings
folder=WORK/'selection';rows=json.loads((folder/'candidates.json').read_text())
model=SonoBridge(APP/'sonobridge/weights/sonobridge_liver_3.4MHz_480k.pt');rank=[]
for row in rows:
 i=row['index'];z=np.load(folder/f'input_{i:03d}.npz');us=np.where(z['active'],np.load(folder/f'us_{i:03d}.npy'),0).astype(np.uint8)
 args=[us,z['ct_hu'],z['labels'],z['vessels']];outputs=[]
 for name,shadow,gain in [('default',0,1),('shadow',-40,1),('fine',0,0)]:
  a=model(*args,BridgeSettings(seed=1042,shadow_area_percent=shadow,structure_gain=gain).to_dict());outputs.append(a)
  Image.fromarray(a).save(folder/f'{i:03d}_{name}.png')
  if name=='default':maps={k:v.copy() for k,v in model.last_maps.items()};diag=dict(model.last_diagnostics)
 organ=ndi.binary_erosion((z['labels']==4)&z['valid']&(maps['visibility']>180),iterations=5)
 eligible=organ & ~ndi.binary_dilation(z['vessels'],iterations=5)
 # Appearance-only dark islands are ranked outside the native vessel support.
 a=outputs[2].astype(float);local=ndi.gaussian_filter(a,4);dark=eligible&(a<local-14)&(a<48)
 comps,n=ndi.label(dark);counts=np.bincount(comps.ravel());small=np.flatnonzero((counts>=6)&(counts<220));small=small[small!=0]
 extra=int(sum(counts[small]));sh=float(np.abs(outputs[0].astype(float)-outputs[1])[z['valid']].mean());fine=float(np.abs(outputs[0].astype(float)-outputs[2])[z['valid']].mean())
 row.update(shadow_mae=sh,fine_mae=fine,support=diag['support_pixels'],shadow_area=diag['default_shadow_area'],extra_dark_pixels=extra,extra_dark_components=len(small),clean_liver_pixels=int(eligible.sum()))
 row['usable']=diag['support_pixels']>120 and sh>2 and fine>3 and bool(eligible.sum()>3500)
 row['score']=min(fine,15)+min(sh,10)+5*row['whole_contact']-extra/35-len(small)*.35
 rank.append(row);print(i,row['case'],'extra',extra,len(small),'shadow/fine',round(sh,2),round(fine,2),'usable',row['usable'],flush=True)
rank.sort(key=lambda r:(not r['usable'],-r['score']));(folder/'ranking.json').write_text(json.dumps(rank,indent=2))
top=[r for r in rank if r['usable']][:8]
canvas=Image.new('RGB',(1056,top.__len__()*284),'#d4d2cb');draw=ImageDraw.Draw(canvas)
for j,row in enumerate(top):
 for k,name in enumerate(['default','shadow','fine']):
  a=Image.open(folder/f'{row["index"]:03d}_{name}.png').convert('RGB').resize((336,244))
  canvas.paste(a,(k*352+8,j*284+28));draw.text((k*352+8,j*284+7),f'{row["case"]} / {row["index"]} | {name} | islands {row["extra_dark_components"]}',fill='#263334')
canvas.save(folder/'comparison.jpg');print('TOP',[(r['case'],r['index'],r['score']) for r in top],flush=True)
