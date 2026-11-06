"""Blender background script: plan A-09..A-24 + supplied facade reference.
Run: blender -b --factory-startup --python scripts/build-building3.py
No source PDF or user Blender file is modified. Coordinates below are Y-up metres.
"""
import bpy, math, json
from pathlib import Path
from mathutils import Vector

bpy.ops.wm.read_factory_settings(use_empty=True)
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'models'
OUT.mkdir(parents=True, exist_ok=True)
LEVELS = [0.16, 4.2, 7.7, 11.2, 14.7]
COLORS = {'pink': '#d993b5', 'band': '#c67a9f', 'white': '#eef0ec', 'slab': '#cdd1cf',
          'glass': '#92b6bd', 'frame': '#dce3e0', 'roof': '#e2e6b6', 'steel': '#839693',
          'door': '#b6bbb3', 'wood': '#bc9870', 'board': '#31554b', 'tile': '#e4e2d6'}
buckets = {}
def xyz(p): return (p[0], -p[2], p[1])
def poly(part,mat,verts,faces):
    v,f=buckets.setdefault((part,mat),([],[])); n=len(v)
    v.extend(xyz(p) for p in verts); f.extend(tuple(n+i for i in q) for q in faces)
def box(part,mat,c,s):
    x,y,z=c; a,b,d=[t/2 for t in s]
    v=[(x+dx*a,y+dy*b,z+dz*d) for dx,dy,dz in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    poly(part,mat,v,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(3,7,6,2),(0,4,7,3),(1,2,6,5)])
def beam(part,mat,a,b,w=0.05):
    a,b=Vector(a),Vector(b); direction=(b-a).normalized()
    u=direction.cross(Vector((0,1,0)))
    if u.length<0.01:u=direction.cross(Vector((1,0,0)))
    u.normalize();u*=w/2;v=direction.cross(u).normalized()*w/2
    verts=[tuple(p+su*u+sv*v) for p in (a,b) for su,sv in [(-1,-1),(1,-1),(1,1),(-1,1)]]
    poly(part,mat,verts,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)])
def rail(part,a,b,base,height=1.05):
    beam(part,'steel',(a[0],base+height,a[1]),(b[0],base+height,b[1]),0.055)
    length=math.hypot(b[0]-a[0],b[1]-a[1]);n=max(1,math.ceil(length/1.0))
    for i in range(n+1):
        t=i/n;x=a[0]+(b[0]-a[0])*t;z=a[1]+(b[1]-a[1])*t
        box(part,'steel',(x,base+height/2,z),(0.035,height,0.035))
def window(part,x,y,z,width=2.7):
    box(part,'glass',(x,y,z),(width,1.5,0.045))
    for dx in [-width/2,0,width/2]:box(part,'frame',(x+dx,y,z+0.03),(0.055,1.6,0.07))
    for dy in [-0.78,0.1,0.78]:box(part,'frame',(x,y+dy,z+0.03),(width+0.1,0.05,0.08))
def classroom(part,start,end,base,special=False):
    # Plan front wall has an actual door opening; no opaque wall behind the door.
    front=part+'_FRONT';door_x=start+1.05;mid=(start+end)/2
    box(front,'pink',(mid,base+0.48,2.75),(end-start,0.96,0.15))
    # Remove the sill under the doorway by splitting its two sides.
    # The broad sill is replaced below, before export, through explicit segments.
    v,f=buckets[(front,'pink')];del v[-8:];del f[-6:]
    for left,right in [(start,door_x-.5),(door_x+.5,end)]:
        if right>left:box(front,'pink',((left+right)/2,base+.48,2.75),(right-left,.96,.15))
    box(front,'pink',(mid,base+2.85,2.75),(end-start,.75,.15))
    box(front,'door',(door_x,base+1.05,2.68),(.92,2.1,.06))
    box(front,'frame',(door_x+.33,base+1.0,2.73),(.04,.1,.035))
    w=max(1.8,end-start-2.3);window(front,start+2.0+w/2,base+1.73,2.78,w)
    for x in [start+i*4+2 for i in range(int((end-start)/4))]:
        window(part,x,base+1.8,-5.29)
    box(part,'board',(start+.11,base+1.5,-1.2),(.045,1.25,3.2))
    box(part,'wood',(start+1.2,base+.75,-1.0),(1.1,.08,.65))
    cols=5 if special else 4
    for row in range(4):
        for col in range(cols):
            x=start+2.0+row*(end-start-3)/4;z=-4.3+col*1.35
            box(part,'wood',(x,base+.73,z),(1.0,.065,.58))
            box(part,'steel',(x,base+.36,z),(.08,.72,.08))
            box(part,'wood',(x+.7,base+.43,z),(.42,.07,.42))
def stairs(floor,base,upper,c):
    p=f'B3_FLOOR_{floor}_STAIRS';rise=(upper-base)/24;run=.29
    # Two opposed flights, with a real open stairwell in upper floor plates.
    for i in range(12):
        box(p,'slab',(c-.87,base+(i+.5)*rise,2.55-(i+.5)*run),(1.5,rise,run))
        box(p,'slab',(c+.87,base+(12+i+.5)*rise,-.93+(i+.5)*run),(1.5,rise,run))
    box(p,'slab',(c,base+12*rise-.1,-1.5),(3.8,.2,1.2))
    for x in [c-1.65,c-.09]:
        beam(p,'steel',(x,base+.95,2.55),(x,base+12*rise+.95,-.93),.06)
        for i in range(0,12,2):box(p,'steel',(x,base+(i+1)*rise+.48,2.55-(i+.5)*run),(.035,.96,.035))
    for x in [c+.09,c+1.65]:
        beam(p,'steel',(x,base+12*rise+.95,-.93),(x,upper+.95,2.55),.06)
        for i in range(0,12,2):box(p,'steel',(x,base+(13+i)*rise+.48,-.93+(i+.5)*run),(.035,.96,.035))
    rail(p,(c-1.8,-2.1),(c+1.8,-2.1),base+12*rise)

box('B3_FLOOR_1','tile',(0,.08,0),(83,.16,13.5))
for floor in range(1,5):
    p=f'B3_FLOOR_{floor}';base=LEVELS[floor-1];upper=LEVELS[floor];height=upper-base
    for x in range(-40,41,4):
        for z in [-5.25,2.75,5.25]:
            box(p,'pink' if floor<=2 else 'white',(x,base+height/2,z),(.38,height,.38))
    # Front/rear beams and front fascia at every ceiling line.
    for z in [-5.25,2.75,5.25]:box(p,'pink',(0,upper-.19,z),(80,.38,.34))
    if floor>1:
        # Classroom floor panels skip both stair bays [-28,-24] and [24,28].
        for a,b in [(-40,-28),(-24,24),(28,40)]:box(p,'slab',((a+b)/2,base-.1,-1.25),(b-a,.2,8))
        box(p,'slab',(0,base-.1,4),(80,.2,2.5))
        box(p,'band',(0,base-.24,5.3),(80,.3,.2))
        for left,right in [(-40,-28.3),(-23.7,23.7),(28.3,40)]:rail(p,(left,5.32),(right,5.32),base)
        for z in [-5.25]:
            box(p,'pink',(0,base+.45,z),(80,.9,.17))
            box(p,'pink',(0,base+3.02,z),(80,.8,.17))
            for x in range(-40,41,4):box(p,'pink',(x,base+1.85,z),(.38,2.0,.22))
        # Ends close the classroom depth, leaving the front gallery open for access.
        for x in [-40,40]:box(p,'pink',(x,base+1.62,-1.25),(.18,3.24,8))
        rooms=[(-24+i*8,-16+i*8) for i in range(6)]
        rooms += [(-36,-28),(28,36)] if floor==2 else [(-40,-28),(28,40)]
        for a,b in rooms:
            classroom(p,a,b,base,b-a>8)
            if a>-40:box(p,'white',(a,base+1.6,-1.25),(.14,3.2,8))
        if floor==2:
            for c in [-38,38]:
                box(p,'white',(c,base+1.5,-1.25),(3.7,3,0.12))
                for z in [-4.4,-3.1,-1.8]:
                    box(p,'white',(c,base+1.05,z),(3.6,2.1,.08))
                    box(p,'door',(c+.9,base+1,z+.5),(.8,2,.06))
                    box(p,'white',(c-.8,base+.35,z+.5),(.42,.65,.6))
        for c in [-26,26]:
            box(p,'slab',(c,base-.1,2.65),(4,.2,.2))
            box(p,'slab',(c,base-.1,6.2),(4.6,.2,1.9))
            rail(p,(c-2.3,7.15),(c+2.3,7.15),base)
            rail(p,(c-2.3,5.3),(c-2.3,7.15),base)
            rail(p,(c+2.3,5.3),(c+2.3,7.15),base)
    if floor<4:
        for c in [-26,26]:stairs(floor,base,LEVELS[floor],c)
    # Slim stair-head vertical strips echo the elevation A-17 / A-22.
    for c in [-26,26]:
        for dx in [-1.85,1.85]:box(p,'pink',(c+dx,base+height/2,6.2),(.25,height,.28))

# A hipped roof with 1.5 m overhang, based on section A-14 and elevations.
eave=14.9;ridge=17.7
poly('B3_ROOF','roof',[(-41.5,eave,-6.75),(41.5,eave,-6.75),(41.5,eave,6.75),(-41.5,eave,6.75),(-34,ridge,0),(34,ridge,0)],[(0,4,5,1),(3,2,5,4),(0,3,4),(1,5,2)])
for z in [-6.75,6.75]:box('B3_ROOF','white',(0,eave,z),(83,.2,.16))
beam('B3_ROOF','roof',(-34,ridge+.035,0),(34,ridge+.035,0),.12)
for x in range(-33,34):
    for z in [-6.7,6.7]:beam('B3_ROOF','roof',(x,eave+.025,z),(x,ridge+.025,0),.025)

materials={}
def linear_channel(c):return c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4
for name,color in COLORS.items():
    mat=bpy.data.materials.new(name);mat.diffuse_color=tuple(linear_channel(int(color[i:i+2],16)/255) for i in (1,3,5))+(1,)
    mat.use_nodes=True;bsdf=mat.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Base Color'].default_value=mat.diffuse_color;bsdf.inputs['Roughness'].default_value=.73
    if name=='steel':bsdf.inputs['Metallic'].default_value=.35
    materials[name]=mat
parents={}
for (part,mat),(verts,faces) in buckets.items():
    mesh=bpy.data.meshes.new(part+'_'+mat);mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new(part+'_'+mat,mesh);bpy.context.collection.objects.link(obj);mesh.materials.append(materials[mat])
    parent_name='B3_ROOF' if part=='B3_ROOF' else '_'.join(part.split('_')[:3])
    if parent_name not in parents:
        parent=bpy.data.objects.new(parent_name,None);bpy.context.collection.objects.link(parent);parents[parent_name]=parent
        parent['floor']=0 if parent_name=='B3_ROOF' else int(parent_name[-1])
    obj.parent=parents[parent_name]
    obj['layer']='front' if part.endswith('_FRONT') else 'stairs' if part.endswith('_STAIRS') else 'structure'
    obj['building']='building-3'
bpy.ops.export_scene.gltf(filepath=str(OUT/'building-3.glb'),export_format='GLB',export_animations=False,export_extras=True)
print('BUILDING_3_EXPORTED',len(buckets),'material batches')
