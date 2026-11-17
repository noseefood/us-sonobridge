"""Closed, case-specific posterior display anatomy for the kidney explorer."""
from kidney_assets import *
import pyvista as pv
import trimesh
from scipy import ndimage
meta=json.loads((WORK/'grid_meta.json').read_text());patient,cfg=patient_for(meta['case_id'])
from sonobridge_core.geometry.closed_display import cached_closed_display
folder=WORK/'surfaces';folder.mkdir(exist_ok=True);reports=[]
for name,label,budget in [('Skin',13,10000),('Kidneys',2,30000),('Liver',4,10000),('Bones',14,22000),('Spleen',1,4000)]:
 mask=~patient.exterior_air if name=='Skin' else patient.labels==label
 if not mask.any():continue
 if name=='Kidneys':
  occupied=[np.flatnonzero(mask.any(axis=tuple(j for j in range(3) if j!=i))) for i in range(3)];lo=np.array([x[0] for x in occupied]);hi=np.array([x[-1]+1 for x in occupied]);density=ndimage.gaussian_filter(np.pad(mask[tuple(slice(a,b) for a,b in zip(lo,hi))].astype(np.float32),3),1.1)
  grid=pv.ImageData(dimensions=density.shape);grid.point_data['occupancy']=density.ravel(order='F');surface=grid.contour([.5],method='flying_edges');surface.points=(surface.points+lo-3)@patient.affine[:3,:3].T+patient.affine[:3,3]
  surface=surface.smooth_taubin(n_iter=35,pass_band=.1,normalize_coordinates=True);inv=np.linalg.inv(patient.affine[:3,:3]);ijk=(surface.points-patient.affine[:3,3])@inv.T
  for axis in range(3):ijk[ijk[:,axis]<0,axis]=-.5;ijk[ijk[:,axis]>mask.shape[axis]-1,axis]=mask.shape[axis]-.5
  surface.points=ijk@patient.affine[:3,:3].T+patient.affine[:3,3];surface=surface.decimate_pro(max(0,1-budget/surface.n_cells),preserve_topology=True,splitting=False,boundary_vertex_deletion=False)
  mesh=trimesh.Trimesh(surface.points,surface.faces.reshape(-1,4)[:,1:],process=True);mesh.fix_normals(multibody=True);vertices=mesh.vertices;faces=mesh.faces
  _,edges=np.unique(mesh.edges_sorted,axis=0,return_counts=True);assert not np.any(edges==1)
  report=dict(boundary_edges=0,faces=len(faces),watertight=bool(mesh.is_watertight),dense_smoothing=True)
 else:vertices,faces,report=cached_closed_display(mask,patient.affine,folder/f'{name}_native.npz',target_faces=budget,cap_offset_mm=.3 if name=='Skin' else 0)
 T=patient.T_world_ct_mm;vertices=vertices@T[:3,:3].T+T[:3,3];poly=pv.PolyData(vertices,np.c_[np.full(len(faces),3),faces]).compute_normals(split_vertices=True,feature_angle=55,consistent_normals=False)
 np.savez_compressed(folder/f'{name}.npz',vertices=poly.points,faces=poly.faces.reshape(-1,4)[:,1:],normals=poly.point_data['Normals'])
 reports.append(dict(name=name,**report));print(name,len(faces),flush=True)
(folder/'surfaces.json').write_text(json.dumps(reports,indent=2))
