from common import *
from sonobridge_core.geometry.closed_display import cached_closed_display
from sonobridge_core.data.labels import PALETTE
meta=json.loads((WORK/'grid_meta.json').read_text());patient,cfg=patient_for(meta['case_id'])
folder=WORK/'surfaces';folder.mkdir(exist_ok=True);reports=[]
for name,label,budget in [('Skin',13,16000),('Liver',4,22000),('Kidneys',2,14000),('Bones',14,32000),('Vessels',6,16000),('Spleen',1,7000),('Gallbladder',3,4000),('Pancreas',7,6000)]:
 mask=~patient.exterior_air if name=='Skin' else patient.labels==label
 if not mask.any():continue
 vertices,faces,report=cached_closed_display(mask,patient.affine,folder/f'{name}_native.npz',target_faces=budget,cap_offset_mm=.3 if name=='Skin' else 0)
 T=patient.T_world_ct_mm;vertices=vertices@T[:3,:3].T+T[:3,3]
 np.savez_compressed(folder/f'{name}.npz',vertices=vertices,faces=faces)
 reports.append(dict(name=name,color=(PALETTE[label]/255).tolist(),**report));print(name,report,flush=True)
(folder/'surfaces.json').write_text(json.dumps(reports,indent=2))
