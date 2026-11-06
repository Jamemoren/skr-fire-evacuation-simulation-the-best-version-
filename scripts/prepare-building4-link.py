"""Clip a bridge doorway from the original GLB; keep its floor and source file intact."""
import bpy
from pathlib import Path
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
root=Path(__file__).resolve().parents[1]
bpy.ops.import_scene.gltf(filepath=str(root/'public/models/campus-extension.glb'))
bpy.context.view_layer.update()
s=.416;sy=11.2/28.2
lo=Vector((29/s,-6.8/s,11.25/sy));hi=Vector((33/s,-5.5/s,14/sy))
planes=[(i,1,lo[i]) for i in range(3)]+[(i,-1,-hi[i]) for i in range(3)]
def split(poly,i,sign,bound):
    yes=[];no=[]
    for j,a in enumerate(poly):
        b=poly[(j+1)%len(poly)];da=sign*a[i]-bound;db=sign*b[i]-bound
        (yes if da>=0 else no).append(a)
        if (da>=0)!=(db>=0):
            p=a+(b-a)*(da/(da-db));yes.append(p);no.append(p)
    return yes,no
modified=0
for obj in bpy.context.scene.objects:
    if obj.type!='MESH':continue
    matrix=obj.matrix_world.copy();inverse=matrix.inverted();verts=[];faces=[];mats=[];changed=False
    for face in obj.data.polygons:
        poly=[matrix@obj.data.vertices[i].co for i in face.vertices]
        if any(max(p[i] for p in poly)<lo[i] or min(p[i] for p in poly)>hi[i] for i in range(3)):pieces=[poly]
        else:
            candidates=[poly];pieces=[]
            for i,sign,bound in planes:
                new=[]
                for polygon in candidates:
                    yes,no=split(polygon,i,sign,bound)
                    if len(no)>=3:pieces.append(no)
                    if len(yes)>=3:new.append(yes)
                candidates=new
            changed=True
        for polygon in pieces:
            start=len(verts);verts.extend(inverse@p for p in polygon);faces.append(tuple(range(start,start+len(polygon))));mats.append(face.material_index)
    if changed:
        mesh=bpy.data.meshes.new(obj.name+'_BRIDGE_PORTAL');mesh.from_pydata(verts,[],faces);mesh.update()
        for mat in obj.data.materials:mesh.materials.append(mat)
        for face,index in zip(mesh.polygons,mats):face.material_index=index
        obj.data=mesh;modified+=1
bpy.ops.export_scene.gltf(filepath=str(root/'public/models/building-4-linked.glb'),export_format='GLB',export_animations=False)
print('BUILDING4_PORTAL_PREPARED',modified,'meshes')
