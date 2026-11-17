"""Presentation meshes: smooth the dense occupancy surface before decimation.
Native CT, labels, probe poses and ultrasound records are never changed.
"""
from common import *
import pyvista as pv
from scipy import ndimage
import trimesh
from scipy.sparse import coo_matrix
def display_normals(vertices,faces):
 normals=np.zeros_like(vertices)
 face_normals=np.cross(vertices[faces[:,1]]-vertices[faces[:,0]],vertices[faces[:,2]]-vertices[faces[:,0]])
 for i in range(3):np.add.at(normals,faces[:,i],face_normals)
 normals/=np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-15)
 edges=np.concatenate([faces[:,[0,1]],faces[:,[1,2]],faces[:,[2,0]]]);edges=np.concatenate([edges,edges[:,::-1]])
 adjacency=coo_matrix((np.ones(len(edges)),(edges[:,0],edges[:,1])),shape=(len(vertices),len(vertices))).tocsr();adjacency.data[:]=1
 degree=np.maximum(np.asarray(adjacency.sum(axis=1)),1)
 for _ in range(4):
  normals=.35*normals+.65*(adjacency@normals)/degree
  normals/=np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-15)
 return normals.astype(np.float32)
source=WORK/'surfaces';dest=WORK/'surfaces-polished';dest.mkdir(exist_ok=True)
meta=json.loads((WORK/'grid_meta.json').read_text());patient,cfg=patient_for(meta['case_id'])
reports=json.loads((source/'surfaces.json').read_text())
for report in reports:
 name=report['name']
 if name not in ['Liver','Kidneys']:
  z=np.load(source/f'{name}.npz');np.savez_compressed(dest/f'{name}.npz',vertices=z['vertices'],faces=z['faces']);continue
 mask=patient.labels==(4 if name=='Liver' else 2);affine=patient.affine
 occupied=[np.flatnonzero(mask.any(axis=tuple(j for j in range(3) if j!=i))) for i in range(3)]
 lo=np.array([x[0] for x in occupied]);hi=np.array([x[-1]+1 for x in occupied])
 density=ndimage.gaussian_filter(np.pad(mask[tuple(slice(a,b) for a,b in zip(lo,hi))].astype(np.float32),3),1.1)
 grid=pv.ImageData(dimensions=density.shape);grid.point_data['occupancy']=density.ravel(order='F')
 surface=grid.contour([.5],method='flying_edges');surface.points=(surface.points+lo-3)@affine[:3,:3].T+affine[:3,3]
 surface=surface.smooth_taubin(n_iter=35,pass_band=.1,normalize_coordinates=True)
 # Preserve the closed scan-cut planes used by the existing display geometry.
 inverse=np.linalg.inv(affine[:3,:3]);ijk=(surface.points-affine[:3,3])@inverse.T
 for axis in range(3):
  ijk[ijk[:,axis]<0,axis]=-.5;ijk[ijk[:,axis]>mask.shape[axis]-1,axis]=mask.shape[axis]-.5
 surface.points=ijk@affine[:3,:3].T+affine[:3,3]
 connected=surface.connectivity();labels=connected.cell_data['RegionId'];ids,counts=np.unique(labels,return_counts=True)
 keep=ids[counts>counts.max()*.005];surface=connected.extract_cells(np.isin(labels,keep)).extract_surface().triangulate()
 count=surface.n_cells;target=42000 if name=='Liver' else 36000
 surface=surface.decimate_pro(max(0,1-target/count),preserve_topology=True,splitting=False,boundary_vertex_deletion=False)
 mesh=trimesh.Trimesh(surface.points,surface.faces.reshape(-1,4)[:,1:],process=True)
 _,edgecounts=np.unique(mesh.edges_sorted,axis=0,return_counts=True);assert not np.any(edgecounts==1),(name,'open boundary')
 mesh.fix_normals(multibody=True)
 display=pv.PolyData(mesh.vertices,np.c_[np.full(len(mesh.faces),3),mesh.faces]).compute_normals(split_vertices=True,feature_angle=55,consistent_normals=False)
 T=patient.T_world_ct_mm;vertices=display.points@T[:3,:3].T+T[:3,3]
 faces=display.faces.reshape(-1,4)[:,1:]
 np.savez_compressed(dest/f'{name}.npz',vertices=vertices,faces=faces,normals=display_normals(vertices,faces))
 report.update(version='closed-display-polished-1',source_faces=count,target_faces=target,display_faces=display.n_cells,watertight=bool(mesh.is_watertight),boundary_edges=0,nonmanifold_edges=int(np.sum(edgecounts>2)),gaussian_sigma_voxels=1.1,taubin_iterations=35,display_components=len(keep))
 print(name,report,flush=True)
(dest/'surfaces.json').write_text(json.dumps(reports,indent=2))
