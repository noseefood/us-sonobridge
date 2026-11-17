"""Run the native OptiX simulator with its existing Python 3.10 environment."""
from pathlib import Path
import sys,json,gc
sys.dont_write_bytecode=True
import numpy as np,yaml
ROOT=Path(__file__).resolve().parents[2];APP=Path('/home/xuesong-li/Research_IFL/CT-MRI2US/SonoGym/apps/sonobridge')
folder=ROOT/'refs/demo-build'/('grid' if 'grid' in sys.argv else 'selection')
rows=json.loads((folder/'candidates.json').read_text());cfg=yaml.safe_load((APP/'config/scene.yaml').read_text());rc=cfg['raytracing'];pc=cfg['probe']
sys.path.insert(0,str(APP/'vendor'));import raysim.cuda as rs
for case in sorted(set(r['case'] for r in rows)):
 materials=rs.Materials();world=rs.World('muscle')
 for path in sorted((APP/f'assets/patients/{case}/meshes').glob('*.obj')):
  world.add(rs.Mesh(str(path),materials.get_index(rc['material_lut'].get(path.stem,'air'))))
 simulator=rs.RaytracingUltrasoundSimulator(world,materials)
 probe=rs.CurvilinearProbe(rs.Pose(np.zeros(3,np.float32),np.zeros(3,np.float32)),num_elements_x=pc['num_scanlines'],sector_angle=pc['sector_angle_deg'],radius=pc['radius_mm'],frequency=3.4,elevational_height=pc['elevation_width_mm'],num_el_samples=rc['elevation_samples'])
 params=rs.SimParams();params.conv_psf=True;params.buffer_size=rc['buffer_size'];params.t_far=pc['depth_mm'];params.enable_cuda_timing=False;params.median_clip_filter=rc['median_clip_filter'];params.contact_epsilon=rc['contact_epsilon_mm'];params.b_mode_size=(256,256)
 for r in rows:
  if r['case']!=case:continue
  probe.set_pose(rs.Pose(np.array(r['native_position'],np.float32),np.array(r['native_angles'],np.float32)))
  bmode=np.asarray(simulator.simulate(probe,params));lo,hi=rc['b_mode_db_range']
  np.save(folder/f'us_{r["index"]:03d}.npy',(np.clip((bmode-lo)/(hi-lo),0,1)*255).astype(np.uint8))
 print('Simulated',case,flush=True)
 del simulator,probe,world,materials;gc.collect()
