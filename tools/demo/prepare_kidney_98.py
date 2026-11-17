"""Reuse native 00098 CT/labels and MONAI medulla; derive posterior cache locally."""
from pathlib import Path
import numpy as np,nibabel as nib,json,shutil
from scipy import ndimage as ndi
ROOT=Path(__file__).resolve().parents[2];W=ROOT/'refs/demo-build/kidney/patient-00098';W.mkdir(parents=True,exist_ok=True)
L=Path('/home/xuesong-li/Research_IFL/CT-MRI2US/SonoGym/apps/sonobridge');source=L/'assets/patients/00098';derived=L/'artifacts/patients/00098'
for name in ['ct.nii.gz','labels.nii.gz','provenance.json']:
 dest=W/name
 if not dest.exists():dest.symlink_to(source/name)
if not (W/'meshes').exists():(W/'meshes').symlink_to(source/'meshes',target_is_directory=True)
shutil.copy2(derived/'patient_skin.npz',W/'patient_skin.npz')
base=Path('/home/xuesong-li/Research_IFL/CT-MRI2US/CT2US_Training/Datasets/Liver/sim_data')
support=base/'00098/support_mask/kidney_structure_monai/kidney_substructure_pred.nii.gz';p=nib.load(support)
# Confirm the native app's binary convention from an existing imported case.
a=np.asarray(nib.load(base/'00092/support_mask/kidney_structure_monai/kidney_substructure_pred.nii.gz').dataobj)==2
b=np.asarray(nib.load(L.parent/'sonobridge_kidney/assets/patients/00092/kidney_medulla.nii.gz').dataobj)>0
assert np.array_equal(a,b)
medulla=(np.asarray(p.dataobj)==2).astype(np.uint8);nib.save(nib.Nifti1Image(medulla,p.affine),W/'kidney_medulla.nii.gz')
with np.load(derived/'patient.npz') as f:
 data={k:f[k] for k in ['ct','labels','affine','interior_mm','distance_affine']}
assert data['ct'].shape==p.shape and np.allclose(data['affine'],p.affine)
skin=data['labels']==13;valid=skin.any(axis=1);ymin=np.argmax(skin,axis=1);weights=ndi.gaussian_filter(valid.astype(float),1.5)
surface=ndi.gaussian_filter(ymin*valid,1.5)/np.maximum(weights,1e-6)
comp,count=ndi.label(data['labels'][::2,::2,::2]==2);sizes=np.bincount(comp.ravel());sizes[0]=0
centers=[np.asarray(ndi.center_of_mass(comp==i))*2 for i in np.argsort(sizes)[-2:] if sizes[i]>100]
center=min(centers,key=lambda c:(data['affine'][:3,:3]@c+data['affine'][:3,3])[0])
np.savez_compressed(W/'patient.npz',**data,surface=surface.astype(np.float32),surface_valid=valid,kidney_center_ijk=center)
report=dict(case='00098',ct_source=str(source/'ct.nii.gz'),labels_source=str(source/'labels.nii.gz'),medulla_source=str(support),medulla_class=2,medulla_voxels=int(medulla.sum()),shape=list(p.shape),native_grid_alignment=True,posterior_height_map='same algorithm as native kidney prepare.py')
(W/'preparation.json').write_text(json.dumps(report,indent=2));print(report,flush=True)
