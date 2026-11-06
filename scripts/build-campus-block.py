"""Complete shared Building 3/4 reconstruction from reference facades; model metres match campusData."""
import bpy,math
from pathlib import Path
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
root=Path(__file__).resolve().parents[1]
SX=.416;SY=11.2/28.2;CX=-9.367340088;CZ=2.737880974
levels=[.16,11.43*SY,19.8*SY,28.233*SY]
stairs=[(x-CX)*SX for x in [-53,53]]
voids=[((x-2.65,.3,(-6.5-CZ)*SX),(x+2.65,14.9,(9-CZ)*SX)) for x in stairs]
buckets={}
def split(poly,i,sign,b):
 yes=[];no=[]
 for j,a in enumerate(poly):
  v=poly[(j+1)%len(poly)];da=sign*a[i]-b;db=sign*v[i]-b
  (yes if da>=0 else no).append(a)
  if (da>=0)!=(db>=0):
   p=a+(v-a)*(da/(da-db));yes.append(p);no.append(p)
 return yes,no
def subtract(poly,lo,hi):
 if any(max(p[i] for p in poly)<lo[i] or min(p[i] for p in poly)>hi[i] for i in range(3)):return [poly]
 todo=[poly];result=[]
 for i,sign,b in [(i,1,lo[i]) for i in range(3)]+[(i,-1,-hi[i]) for i in range(3)]:
  next=[]
  for p in todo:
   yes,no=split(p,i,sign,b)
   if len(no)>=3:result.append(no)
   if len(yes)>=3:next.append(yes)
  todo=next
 return result
buckets={}
def emit(mat,poly):
 vs,fs=buckets.setdefault(mat,([],[]));n=len(vs);vs.extend((p[0],-p[2],p[1]) for p in poly);fs.append(tuple(range(n,n+len(poly))))
def material(name,color):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True;m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=m.diffuse_color;return m
def box(mat,c,s,cuts=[]):
 x,y,z=c;a,b,d=[v/2 for v in s]
 v=[Vector((x+dx*a,y+dy*b,z+dz*d)) for dx,dy,dz in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
 for f in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(3,7,6,2),(0,4,7,3),(1,2,6,5)]:
  polys=[[v[i] for i in f]]
  for lo,hi in cuts:polys=[r for p in polys for r in subtract(p,lo,hi)]
  for p in polys:emit(mat,p)
def beam(a,b):
 a,b=Vector(a),Vector(b);d=(b-a).normalized();u=d.cross(Vector((0,1,0))).normalized()*.03;v=d.cross(u).normalized()*.03
 p=[p+su*u+sv*v for p in (a,b) for su,sv in [(-1,-1),(1,-1),(1,1),(-1,1)]]
 for f in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]:emit(steel,[p[i] for i in f])

def stair_waist(x,z0,y0,z1,y1):
 # Continuous concrete below the treads, rather than disconnected floating steps.
 p=[Vector((x+dx,y+dy,z)) for z,y in [(z0,y0),(z1,y1)] for dx,dy in [(-1.05,-.22),(1.05,-.22),(1.05,-.055),(-1.05,-.055)]]
 for f in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]:emit(concrete,[p[i] for i in f])

concrete=material('Complete level slabs',(.56,.59,.57))
rose=material('Reference pink facade',(.76,.43,.58))
cream=material('Classroom plaster',(.73,.74,.70))
white=material('White columns and frames',(.87,.88,.84))
steel=material('Continuous balcony and stair rails',(.55,.62,.59))
glass=material('Classroom window glass',(.25,.36,.41))
roof=material('Pale cream pitched roof',(.80,.84,.58))
joint=material('Pink facade floor joints',(.56,.22,.38))
rooms=[[-80,-57.7,-68],[-45.5,-33.9,-42.8],[-30.9,-18.4,-27.2],[-15.6,-2,-11.6],[1.1,15.2,5.4],[18.4,30.8,22],[34,46,37.8],[60,80,69]]
top=14.55
box(concrete,(0,.08,0),(77,.16,15.2))
# Solid rear/end facades, with only small floor-4 bridge portals.
box(rose,(0,(top+.16)/2,-7.45),(76.4,top-.16,.24))
portals=[((-40,levels[3]+.025,1.65),(-37.5,14.1,4.4)),((37.5,levels[3]+.025,1.65),(40,14.1,4.4))]
for x in [-38,38]:box(rose,(x,(top+.16)/2,0),(.28,top-.16,15.0),portals)
for y in levels[1:]:
 box(concrete,(0,y-.12,0),(77,.24,15.2),voids)
 box(joint,(0,y-.08,-7.59),(76.4,.045,.035))
 for x in [-38.16,38.16]:box(joint,(x,y-.08,0),(.035,.045,15),portals)
 box(rose,(0,y-.08,7.48),(76.4,.48,.22))
 box(white,(0,y+.98,7.35),(76.4,.055,.055))
 box(white,(0,y+.23,7.35),(76.4,.045,.045))
 for i in range(65):box(white,(-38+i*76/64,y+.60,7.35),(.035,.75,.035))

# Double-height pink lower pilasters and white upper columns.
for i in range(19):
 x=-36+i*4
 box(rose,(x,(levels[2]+.16)/2,7.35),(.50,levels[2]+.16,.55))
 box(white,(x,(levels[2]+top)/2,7.35),(.24,top-levels[2],.30))
box(white,(0,levels[2]-.20,7.62),(77,.10,.48))

# Classroom partitions, doors and windows behind a continuous open gallery.
for f,y in enumerate(levels[1:],start=1):
 ceiling=levels[f+1]-.15 if f<3 else top-.10
 height=ceiling-y
 for left,right,door in rooms:
  a=(left-CX)*SX;b=(right-CX)*SX;d=(door-CX)*SX
  for c in stairs:
   if c-2.75<a<c+2.75:a=c+2.75
   if c-2.75<b<c+2.75:b=c-2.75
  for x in [a,b]:box(cream,(x,y+height/2,-2.75),(.16,height,9.1),voids)
  for lo,hi in [(a,d-.60),(d+.60,b)]:
   width=hi-lo
   if width<=.05:continue
   if width<1.25:
    box(cream,((lo+hi)/2,y+height/2,1.8),(width,height,.18),voids)
   else:
    box(cream,((lo+hi)/2,y+.47,1.8),(width,.94,.18),voids)
    box(cream,((lo+hi)/2,(y+2.35+ceiling)/2,1.8),(width,ceiling-y-2.35,.18),voids)
    for x in [lo+.07,hi-.07]:box(white,(x,y+1.64,1.8),(.10,1.40,.23),voids)
    for wy in [y+.96,y+2.34]:box(white,((lo+hi)/2,wy,1.8),(width,.07,.23),voids)
    box(glass,((lo+hi)/2,y+1.65,1.8),(max(.05,width-.2),1.31,.035),voids)
    box(white,((lo+hi)/2,y+1.65,1.84),(.05,1.32,.06),voids)
  box(cream,(d,(y+2.36+ceiling)/2,1.8),(1.2,ceiling-y-2.36,.18),voids)
  for x in [d-.60,d+.60]:box(white,(x,y+1.18,1.8),(.07,2.36,.25),voids)
  box(white,(d,y+2.36,1.8),(1.27,.07,.25),voids)

# Actual stairs and supported landings in the calibrated floor voids.
front=(8-CZ)*SX;back=(-2-CZ)*SX;gallery=(10-CZ)*SX
for c in stairs:
 for f in range(3):
  lower=levels[f];upper=levels[f+1];rise=(upper-lower)/24;mid=(lower+upper)/2
  for i in range(12):
   box(concrete,(c-1.28,lower+(i+.5)*rise,front-(i+.5)*(front-back)/12),(2.1,rise,(front-back)/12))
   box(concrete,(c+1.28,mid+(i+.5)*rise,back+(i+.5)*(front-back)/12),(2.1,rise,(front-back)/12))
  stair_waist(c-1.28,front,lower,back,mid)
  stair_waist(c+1.28,back,mid,front,upper)
  box(concrete,(c,mid-.1,back-.5),(5.1,.2,1.0))
  # Rear landing guard remains outside the calibrated U-turn walking line.
  beam((c-2.4,mid+1.03,back-.97),(c+2.4,mid+1.03,back-.97))
  for dx in [-2.4,0,2.4]:box(steel,(c+dx,mid+.5,back-.97),(.04,1,.04))
  for y in [lower,upper]:box(concrete,(c,y-.1,(front+gallery)/2),(5.1,.2,gallery-front))
  for dx in [-2.4,-.18]:beam((c+dx,lower+1.03,front),(c+dx,mid+1.03,back))
  for dx in [.18,2.4]:beam((c+dx,mid+1.03,back),(c+dx,upper+1.03,front))
  for i in range(0,12,2):
   t=(i+.5)/12
   for dx in [-2.4,-.18]:box(steel,(c+dx,lower+(mid-lower)*t+.5,front+(back-front)*t),(.04,1,.04))
   for dx in [.18,2.4]:box(steel,(c+dx,mid+(upper-mid)*t+.5,back+(front-back)*t),(.04,1,.04))

# Closed pitched roof, eaves and gables.
for z in [-8.0,8.0]:
 poly=[Vector((-39,14.58,z)),Vector((39,14.58,z)),Vector((39,15.25,0)),Vector((-39,15.25,0))]
 emit(roof,list(reversed(poly)) if z<0 else poly)
 box(roof,(0,14.53,z),(78,.12,.14))
box(roof,(0,14.53,0),(78,.10,16))
box(roof,(0,15.27,0),(78,.06,.16))
for z in [-8.10,8.10]:box(white,(0,14.48,z),(78,.12,.12))
for x in [-37.2,37.2]:box(white,(x,7.32,7.85),(.09,14.4,.09))
for x in [-39,39]:
 poly=[Vector((x,14.5,-8)),Vector((x,14.5,8)),Vector((x,15.25,0))]
 emit(roof,poly if x>0 else list(reversed(poly)))
for mat,(vs,fs) in buckets.items():
 mesh=bpy.data.meshes.new(mat.name);mesh.from_pydata(vs,[],fs);mesh.update();mesh.materials.append(mat)
 obj=bpy.data.objects.new('CAMPUS_BLOCK_'+mat.name,mesh);bpy.context.collection.objects.link(obj)
bpy.ops.export_scene.gltf(filepath=str(root/'public/models/campus-classroom-block.glb'),export_format='GLB',export_animations=False)
print('COMPLETE_CAMPUS_BLOCK_EXPORTED',len(buckets),'material batches')
