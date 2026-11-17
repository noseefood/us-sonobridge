from pathlib import Path
import bpy,numpy as np,json
ROOT=Path(__file__).resolve().parents[2];WORK=ROOT/'refs/demo-build/kidney';bpy.ops.wm.read_factory_settings(use_empty=True)
for r in json.loads((WORK/'surfaces/surfaces.json').read_text()):
 name=r['name'];z=np.load(WORK/f'surfaces/{name}.npz');m=bpy.data.meshes.new(name);m.from_pydata(z['vertices'].tolist(),[],z['faces'].tolist());m.update()
 for p in m.polygons:p.use_smooth=True
 m.normals_split_custom_set_from_vertices(z['normals'].tolist());o=bpy.data.objects.new('anatomy_'+name,m);bpy.context.scene.collection.objects.link(o)
 mat=bpy.data.materials.new(name);mat.diffuse_color=(.5,.3,.2,1);m.materials.append(mat)
bpy.ops.export_scene.gltf(filepath=str(WORK/'anatomy.glb'),export_format='GLB',export_yup=False,export_apply=True,export_cameras=False,export_lights=False)
