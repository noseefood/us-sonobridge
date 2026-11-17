"""Export lightweight original CAD links and closed case-specific surfaces."""
from pathlib import Path
import bpy,bmesh,json,numpy as np,math,sys
from mathutils import Matrix,Vector
ROOT=Path(__file__).resolve().parents[2];WORK=ROOT/'refs/demo-build';OUT=ROOT/'static/demo'
APP=Path('/home/xuesong-li/Research_IFL/CT-MRI2US/SonoGym/apps/sonobridge')
meta=json.loads((WORK/'grid_meta.json').read_text())
old=bpy.context.scene;old.frame_set(1);dg=bpy.context.evaluated_depsgraph_get()
scene=bpy.data.scenes.new('SonoBridge Web');bpy.context.window.scene=scene
def mat(name,color,rough=.65):
 m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*color,1);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=.02;return m
white=mat('robot_shell',(.68,.70,.68),.52);dark=mat('robot_joints',(.035,.045,.045),.57)
steel=mat('robot_metal',(.42,.47,.46),.42);holder=mat('probe_holder',(.47,.54,.57),.83);ivory=mat('acoustic_probe',(.84,.84,.76),.6)
jointgroups={};count=0;faces=0
def descendants(obj):
 for c in obj.children:
  yield c
  yield from descendants(c)
def visual_meshes(visual,source):
 local=source.matrix_world.inverted()@visual.matrix_world
 if visual.instance_collection:
  for o in visual.instance_collection.all_objects:
   if o.type=='MESH':yield o,local@o.matrix_world
 else:
  for o in descendants(visual):
   if o.type=='MESH':yield o,source.matrix_world.inverted()@o.matrix_world
for name in ['base']+[f'fr3_link{i}' for i in range(9)]:
 source=bpy.data.objects.get(name)
 if source is None:continue
 group=bpy.data.objects.new('web_'+name,None);scene.collection.objects.link(group);jointgroups[name]=group
 for visual in source.children:
  if not visual.name.startswith('visuals'):continue
  for o,local_transform in visual_meshes(visual,source):
   m=o.data.copy();m.transform(local_transform)
   # USD prototypes store disconnected triangles. Weld before simplification,
   # otherwise decimation deletes individual triangles and leaves visible holes.
   bm=bmesh.new();bm.from_mesh(m)
   bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-6)
   bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
   for f in bm.faces:f.smooth=True
   for e in bm.edges:
    if e.is_manifold:e.smooth=e.calc_face_angle()<math.radians(50)
   bm.to_mesh(m);bm.free();m.update()
   if m.has_custom_normals:m.normals_split_custom_set([(0,0,0)]*len(m.loops))
   ob=bpy.data.objects.new('web_'+o.name,m);scene.collection.objects.link(ob);ob.parent=group
   for k,material in enumerate(m.materials):
    if material is None:m.materials[k]=white;continue
    color=material.diffuse_color[:3]
    if material.use_nodes:
     p=material.node_tree.nodes.get('Principled BSDF')
     if p:color=p.inputs['Base Color'].default_value[:3]
    m.materials[k]=white if max(color)>.25 else dark
   if not len(m.materials):m.materials.append(white)
   if len(m.polygons)>4500:
    mod=ob.modifiers.new('Web mesh budget','DECIMATE');mod.ratio=max(.18,4500/len(m.polygons))
   count+=1;faces+=len(m.polygons)
assert count>=8,f'Expected eight FR3 visual links, found {count}'
# Probe parts retain the original flange calibration.
for part in ['3','4','5']:
 z=np.load(APP/f'artifacts/probe_part_{part}.npz');m=bpy.data.meshes.new('probe_part_'+part);m.from_pydata((z['vertices']*.001).tolist(),[],z['faces'].tolist());m.update()
 for p in m.polygons:p.use_smooth=True
 m.materials.append(ivory if part=='5' else holder)
 o=bpy.data.objects.new('web_probe_'+part,m);scene.collection.objects.link(o);o.parent=jointgroups['fr3_link8']
 if len(m.polygons)>7000:mod=o.modifiers.new('Web probe budget','DECIMATE');mod.ratio=7000/len(m.polygons)
# All links are independent world transforms; the browser computes native FK.
kin=meta['kinematics'];q=meta['poses'][110]['q'];trans={'base':Matrix(kin['base'])};k=0
for j in kin['joints']:
 z=Matrix.Identity(4)
 if j['moving']:z=Matrix.Rotation(q[k],4,Vector(j['axis']));k+=1
 trans[j['child']]=trans[j['parent']]@Matrix(j['origin'])@z
for n,o in jointgroups.items():o.matrix_world=trans[n]
surface_folder=WORK/('surfaces-polished' if '--polished' in sys.argv else 'surfaces')
for r in json.loads((surface_folder/'surfaces.json').read_text()):
 name=r['name'];z=np.load(surface_folder/f'{name}.npz');m=bpy.data.meshes.new(name);m.from_pydata(z['vertices'].tolist(),[],z['faces'].tolist());m.update()
 for p in m.polygons:p.use_smooth=True
 if 'normals' in z:m.normals_split_custom_set_from_vertices(z['normals'].tolist())
 color=r['color'];m.materials.append(mat('anatomy_'+name,color,.7))
 o=bpy.data.objects.new('anatomy_'+name,m);scene.collection.objects.link(o)
bpy.context.view_layer.update()
bpy.ops.export_scene.gltf(filepath=str(OUT/'scene.glb'),export_format='GLB',use_active_scene=True,export_yup=False,export_apply=True,export_cameras=False,export_lights=False)
(WORK/'scene_export.json').write_text(json.dumps(dict(robot_meshes=count,source_robot_faces=faces,glb_bytes=(OUT/'scene.glb').stat().st_size,closed_surfaces=True,case=meta['case_id']),indent=2))
print('EXPORTED',count,'robot meshes',faces,'source faces',flush=True)
