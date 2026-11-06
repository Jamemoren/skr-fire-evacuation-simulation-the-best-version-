import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SHRINE_CENTER, SHRINE_ROTATION_Y } from "./siteLayout";

type Point = [number, number, number];

/** Circular stepped shrine and open Thai pavilion, built as a few static material batches. */
export function ShrinePavilion() {
  const model=useMemo(()=>{
    const group=new THREE.Group();group.name="CENTRAL_BUDDHIST_SHRINE";
    const materials:THREE.MeshStandardMaterial[]=[];
    const material=(name:string,color:string,metalness=0,roughness=.78)=>{
      const m=new THREE.MeshStandardMaterial({name,color,metalness,roughness});
      materials.push(m);return m;
    };
    const stone=material("Shrine white stone","#eeeae1");
    const trim=material("White gable and columns","#fffaf0");
    const hedge=material("Shrine hedge panels","#345a38");
    const bronze=material("Dark bronze Buddha","#363936",.58,.43);
    const gold=material("Muted gold ornament","#b99b59",.6,.36);
    const paving=material("Shrine approach paving","#c5c8c2");
    const roof=material("Terracotta roof tiles","#a87647");
    const canvas=document.createElement("canvas");canvas.width=512;canvas.height=512;
    const ctx=canvas.getContext("2d");
    if(ctx){
      ctx.fillStyle="#aa7950";ctx.fillRect(0,0,512,512);
      for(let row=0;row<16;row++)for(let col=-1;col<16;col++){
        const x=col*34+(row%2)*17,y=row*32;
        ctx.fillStyle=["#a8774c","#af8057","#b48760"][(row*7+col+17)%3];
        ctx.fillRect(x+1,y+1,32,30);ctx.strokeStyle="#805936";ctx.strokeRect(x,y,34,32);
      }
    }
    const tile=new THREE.CanvasTexture(canvas);tile.colorSpace=THREE.SRGBColorSpace;
    tile.wrapS=tile.wrapT=THREE.RepeatWrapping;tile.repeat.set(3,2);
    roof.map=tile;
    const batches=new Map<THREE.Material,THREE.BufferGeometry[]>();
    let pavilion=false;
    const add=(geometry:THREE.BufferGeometry,mat:THREE.Material,p:Point=[0,0,0],s:Point=[1,1,1],rotation:Point=[0,0,0])=>{
      let g=geometry;
      if(g.index){g=geometry.toNonIndexed();geometry.dispose();}
      if(!g.getAttribute("uv"))g.setAttribute("uv",new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count*2),2));
      g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...p),new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),new THREE.Vector3(...s)));
      if(pavilion)g.scale(1.35,1,1.2);
      const list=batches.get(mat)??[];list.push(g);batches.set(mat,list);
    };
    const box=(p:Point,s:Point,mat=stone,rotation:Point=[0,0,0])=>add(new THREE.BoxGeometry(...s),mat,p,[1,1,1],rotation);
    const sphere=(p:Point,s:Point,mat=bronze)=>add(new THREE.SphereGeometry(1,16,12),mat,p,s);
    const cylinder=(p:Point,r:number,height:number,mat=stone,segments=64)=>add(new THREE.CylinderGeometry(r,r,height,segments),mat,p);
    const beam=(a:Point,b:Point,r=.06,mat=trim)=>{
      const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),direction=bv.clone().sub(av);
      const geometry=new THREE.CylinderGeometry(r,r,direction.length(),10);
      geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize()));
      add(geometry,mat,av.add(bv).multiplyScalar(.5).toArray() as Point);
    };
    const arc=(inner:number,outer:number,bottom:number,top:number,start:number,end:number,mat:THREE.Material)=>{
      const positions:number[]=[];const segments=Math.ceil((end-start)*20);
      const pt=(r:number,y:number,a:number):Point=>[Math.sin(a)*r,y,Math.cos(a)*r];
      const quad=(a:Point,b:Point,c:Point,d:Point)=>positions.push(...a,...c,...b,...a,...d,...c);
      for(let i=0;i<segments;i++){
        const a=start+(end-start)*i/segments,b=start+(end-start)*(i+1)/segments;
        quad(pt(outer,bottom,a),pt(outer,top,a),pt(outer,top,b),pt(outer,bottom,b));
        quad(pt(inner,bottom,b),pt(inner,top,b),pt(inner,top,a),pt(inner,bottom,a));
        quad(pt(inner,top,a),pt(inner,top,b),pt(outer,top,b),pt(outer,top,a));
        quad(pt(inner,bottom,b),pt(inner,bottom,a),pt(outer,bottom,a),pt(outer,bottom,b));
      }
      for(const a of [start,end])quad(pt(inner,bottom,a),pt(inner,top,a),pt(outer,top,a),pt(outer,bottom,a));
      const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));g.computeVertexNormals();add(g,mat);
    };

    cylinder([0,.03,0],18.1,.10,paving,96);
    cylinder([0,1.05,0],13.5,2.1,stone,96);
    cylinder([0,2.075,0],13.65,.15,trim,96);
    // Ten curved steps rise to the circular platform; the central pavilion remains open.
    for(let i=0;i<10;i++){
      const height=(i+1)*.21;
      add(new THREE.CylinderGeometry(13.5+(10-i)*.42,13.5+(10-i)*.42,height,44,1,false,-.66,1.32),stone,[0,height/2,0]);
    }
    arc(13.0,13.4,2.1,2.8,.72,Math.PI*2-.72,stone);
    for(let i=0;i<10;i++){
      const a=.88+i*(Math.PI*2-1.76)/9;
      arc(13.505,13.57,.55,1.65,a-.17,a+.17,hedge);
      const x=Math.sin(a)*12.9,z=Math.cos(a)*12.9;
      box([x,2.85,z],[2.7,.22,.70],stone,[0,a,0]);
      box([x,3.13,z],[2.55,.40,.56],hedge,[0,a,0]);
    }
    pavilion=true;
    box([0,2.27,-1],[8.4,.34,10.2]);
    for(let i=0;i<3;i++)box([0,2.12+(i+1)*.11,4.65-i*.34],[8.4,.11,.38]);
    for(const x of [-3.4,3.4])for(const z of [-4,0,4]){
      cylinder([x,5.10,z],.22,5.2,trim,20);
      cylinder([x,2.57,z],.31,.20,trim,20);
      cylinder([x,7.64,z],.30,.16,trim,20);
    }
    // Layered temple roof. Its gable points toward the main curved stair.
    for(const side of [-1,1]){
      const profile:[[number,number],[number,number],[number,number],[number,number],[number,number]]=[[0,11.5],[1.1,10.7],[2.5,9.2],[3.7,8.3],[4.7,7.95]];
      const vertices:number[]=[],uv:number[]=[];
      for(let i=1;i<profile.length;i++){
        const a=profile[i-1],b=profile[i];
        const q:Point[]=[[side*a[0],a[1],-5.6],[side*a[0],a[1],5.6],[side*b[0],b[1],5.6],[side*b[0],b[1],-5.6]];
        const order=side<0?[0,2,1,0,3,2]:[0,1,2,0,2,3];
        for(const j of order){vertices.push(...q[j]);uv.push(j===0||j===3?0:1,j<2?(i-1)/4:i/4);}
      }
      const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(vertices,3));g.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));g.computeVertexNormals();add(g,roof);
      for(const z of [-5.66,5.66])beam([0,11.56,z],[side*4.72,7.96,z],.085,trim);
      beam([side*4.72,7.96,-5.7],[side*4.72,7.96,5.7],.065,trim);
      for(const t of [.38,.7])beam([side*4.7*t,11.5-3.55*t,-5.72],[side*4.7*t,11.5-3.55*t,5.72],.035,trim);
    }
    beam([0,11.57,-5.85],[0,11.57,5.85],.095,trim);
    for(const z of [-5.55,5.55]){
      const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute([-4.5,7.9,z,4.5,7.9,z,0,11.38,z],3));g.computeVertexNormals();add(g,trim);
      add(new THREE.ConeGeometry(.14,.60,12),trim,[0,11.88,z]);
    }
    add(new THREE.TorusGeometry(.32,.045,10,32),gold,[0,9.35,5.58]);
    box([0,2.75,-1.6],[5.4,.60,3.6]);
    box([0,3.20,-1.8],[4.6,.30,2.9]);
    box([0,3.65,-1.95],[3.8,.60,2.4]);
    box([0,2.78,1.10],[2.3,.60,1.7]);
    box([0,3.16,1.10],[1.65,.16,1.2]);
    const leaf=new THREE.Shape();leaf.moveTo(0,3.3);leaf.bezierCurveTo(-1.8,1.5,-1.4,.2,0,0);leaf.bezierCurveTo(1.4,.2,1.8,1.5,0,3.3);
    add(new THREE.ExtrudeGeometry(leaf,{depth:.07,bevelEnabled:false,curveSegments:20}),gold,[0,3.8,-2.6]);
    const buddha=(origin:Point,scale:number)=>{
      const p=(x:number,y:number,z:number):Point=>[origin[0]+x*scale,origin[1]+y*scale,origin[2]+z*scale];
      const ell=(x:number,y:number,z:number,s:Point)=>sphere(p(x,y,z),s.map(v=>v*scale) as Point);
      ell(-.42,.30,.10,[.72,.28,.42]);ell(.42,.30,.10,[.72,.28,.42]);
      const profile=[[.05,.40],[.40,.40],[.45,.65],[.35,1.1],[.49,1.42],[.38,1.57],[.12,1.69]].map(([r,y])=>new THREE.Vector2(r*scale,y*scale));
      add(new THREE.LatheGeometry(profile,24),bronze,origin);
      ell(0,1.93,0,[.30,.39,.29]);ell(-.30,1.88,0,[.085,.20,.09]);ell(.30,1.88,0,[.085,.20,.09]);
      ell(0,1.92,.29,[.055,.10,.075]);ell(0,2.30,0,[.15,.17,.15]);
      add(new THREE.ConeGeometry(.07*scale,.30*scale,12),bronze,p(0,2.56,0));
      for(const side of [-1,1]){
        const curve=new THREE.CatmullRomCurve3([p(side*.43,1.4,.02),p(side*.58,.95,.12),p(side*.64,.55,.32),p(side*.30,.56,.44)].map(v=>new THREE.Vector3(...v)));
        add(new THREE.TubeGeometry(curve,16,.10*scale,8,false),bronze);
      }
      for(let row=0;row<4;row++)for(let i=0;i<12;i++){
        const a=i*Math.PI/6;
        ell(Math.sin(a)*(.27-row*.025),2.02+row*.075,Math.cos(a)*(.27-row*.025),[.043,.043,.043]);
      }
    };
    buddha([0,3.96,-1.5],1.04);buddha([0,3.25,1.10],.38);

    for(const [mat,parts]of batches){
      const geometry=mergeGeometries(parts,false);
      parts.forEach(p=>p.dispose());
      if(!geometry)continue;
      const mesh=new THREE.Mesh(geometry,mat);mesh.name=mat.name;mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);
    }
    // Thin roof and gable faces render from both sides when viewed from the open pavilion.
    roof.side=trim.side=stone.side=hedge.side=THREE.DoubleSide;
    return {group,materials,tile};
  },[]);
  useEffect(()=>()=>{model.group.traverse(o=>{if(o instanceof THREE.Mesh)o.geometry.dispose();});model.materials.forEach(m=>m.dispose());model.tile.dispose();},[model]);
  return <group name="CENTRAL_SHRINE_PAVILION" position={SHRINE_CENTER} rotation-y={SHRINE_ROTATION_Y}><primitive object={model.group} dispose={null}/></group>;
}
