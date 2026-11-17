"""Read existing SonoGym assets; generated website assets stay in this repo."""
from pathlib import Path
import sys,json
sys.dont_write_bytecode=True
import numpy as np,yaml
from scipy.spatial.transform import Rotation
ROOT=Path(__file__).resolve().parents[2]
WORK=ROOT/'refs/demo-build';WORK.mkdir(parents=True,exist_ok=True)
OUT=ROOT/'static/demo';OUT.mkdir(parents=True,exist_ok=True)
APP=Path('/home/xuesong-li/Research_IFL/CT-MRI2US/SonoGym/apps/sonobridge')
sys.path[:0]=[str(APP),str(APP/'sonobridge'),str(APP.parents[1]/'packages')]
def configuration(case):
 cfg=yaml.safe_load((APP/'config/scene.yaml').read_text().replace('00091',case))
 cfg['control']['slice_size']=[256,256]
 return cfg
def patient_for(case):
 from sonogym_convex.data import initial_pose
 initial_pose.select_liver_start=lambda p:None
 from sonogym_convex.data.patient import Patient
 cfg=configuration(case)
 return Patient(cfg),cfg
def view_record(patient,face,xy,spin,tilt):
 obs=patient.observation(face,face)
 native=patient.T_ct_mm_world@np.r_[face[:3,3],1]
 rot=patient.T_ct_mm_world[:3,:3]*.001@face[:3,:3]
 contact=patient.contact(face)
 row=dict(face=face.tolist(),xy=np.asarray(xy).tolist(),spin=float(spin),tilt=np.asarray(tilt).tolist(),
  native_position=native[:3].tolist(),native_angles=Rotation.from_matrix(rot).as_euler('xyz').tolist(),
  central_contact=contact.center_fraction,whole_contact=contact.whole_fraction,
  liver_pixels=int(((obs.labels==4)&obs.valid_mask).sum()),vessel_pixels=int((obs.liver_vessels&obs.valid_mask).sum()),
  bone_pixels=int(((obs.labels==14)&obs.valid_mask).sum()))
 arrays=dict(ct_hu=obs.ct_hu,labels=obs.labels,vessels=obs.liver_vessels,valid=obs.valid_mask,
  active=obs.display_lines[patient.canvas_lines]&obs.valid_mask)
 return row,arrays
