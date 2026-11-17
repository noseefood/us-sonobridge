from common import *
import gc
folder=WORK/'selection';folder.mkdir(exist_ok=True)
rows=[]
for case in ['00002','00030','00039','00043','00091','00096','00097','00098']:
 patient,cfg=patient_for(case)
 catalog=json.loads((APP/f'config/initial_views/large_bright/{case}.json').read_text())['candidates']
 chosen=[];checked=0
 for c in catalog:
  if any(np.linalg.norm(np.array(c['xy'])-np.array(q['xy']))<.012 and abs(c['spin_rad']-q['spin'])<.2 for q in chosen):continue
  face,contact,_=patient.project(c['xy'],c['spin_rad'],c['tilt_rad']);checked+=1
  if face is None or contact.center_fraction<.95:continue
  row,arrays=view_record(patient,face,c['xy'],c['spin_rad'],c['tilt_rad'])
  if row['liver_pixels']<7500 or row['vessel_pixels']<180 or row['bone_pixels']<30:continue
  row.update(case=case,index=len(rows));np.savez_compressed(folder/f'input_{len(rows):03d}.npz',**arrays)
  rows.append(row);chosen.append(row)
  if len(chosen)>=6:break
  if checked>220:break
 print(case,'selected',len(chosen),'checked',checked,flush=True)
 del patient;gc.collect()
(folder/'candidates.json').write_text(json.dumps(rows,indent=2))
print('TOTAL',len(rows),flush=True)
