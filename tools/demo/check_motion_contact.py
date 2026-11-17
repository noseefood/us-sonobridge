"""Check interpolated browser poses against native patient skin contact."""
from pathlib import Path
import sys,json,numpy as np
organ=sys.argv[1]
if organ=='liver':import common as native
else:import kidney_assets as native
folder=Path(__file__).resolve().parents[2]/'refs/demo-build/continuous'/organ
data=json.loads((folder/'motion-samples.json').read_text());patient,_=native.patient_for(data['case'])
central=[];whole=[];penetrating=[]
for s in data['samples']:
 c=patient.contact(np.array(s['face']));central.append(c.center_fraction);whole.append(c.whole_fraction);penetrating.append(c.penetrating_fraction)
cp=patient.cfg['contact']
result={'organ':organ,'samples':len(central),'minimum_central_contact':min(central),'minimum_whole_contact':min(whole),'maximum_penetrating_fraction':max(penetrating),'native_thresholds':{k:cp[k] for k in ['min_center_fraction','min_whole_fraction','max_face_penetrating_fraction']}}
(folder/'motion-contact.json').write_text(json.dumps(result,indent=2));print(result)
assert min(central)>=cp['min_center_fraction'] and min(whole)>=cp['min_whole_fraction'] and max(penetrating)<=cp['max_face_penetrating_fraction']
