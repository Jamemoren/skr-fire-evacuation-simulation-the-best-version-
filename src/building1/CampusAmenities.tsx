import { useEffect, useMemo } from "react";
import { CAMPUS_AMENITIES } from "./siteLayout";
import { siteGeometry } from "./staticSiteGeometry";

/** Reference context only: occupancy and unsurveyed indoor routes are not fabricated. */
export function CampusAmenities() {
  const model=useMemo(()=>{
    const b=siteGeometry("REFERENCE_CAMPUS_AMENITIES");
    const white=b.finish("Amenity white frames and columns","#eceee7");
    const cyan=b.finish("Central building pale cyan plaster","#c3e6e4");
    const glass=b.finish("Blue glazing and doors","#4ea1b8");
    const purple=b.finish("Central building violet roof","#8585b6");
    const green=b.finish("East halls green roofs","#398641");
    const orange=b.finish("Parking shelter terracotta orange","#c97a2e");
    const pavement=b.finish("Parking courtyard concrete","#a2a8a9");
    const paint=b.finish("Empty parking bay white markings","#edece5",true);
    for(const a of CAMPUS_AMENITIES){
      const central=a.id==="campus-central-building",floors=central?3:2, floorHeight=a.height/floors;
      b.box(central?cyan:white,[a.x,a.height/2,a.z],[a.width,a.height,a.depth]);
      for(let f=0;f<floors;f++){
        const y=f*floorHeight;
        b.box(white,[a.x,y+.18,a.z],[a.width+.45,.25,a.depth+.45]);
        for(const side of [-1,1]){
          const z=a.z+side*(a.depth/2+.035),n=Math.floor(a.width/3.4);
          for(let i=0;i<n;i++){
            const x=a.x+(i-(n-1)/2)*3.3;
            b.box(glass,[x,y+floorHeight*.57,z],[2.7,floorHeight*.54,.08]);
            b.box(white,[x,y+floorHeight*.57,z+side*.055],[.065,floorHeight*.56,.10]);
          }
          b.box(white,[a.x,y+floorHeight-.1,z],[a.width+.8,.16,.65]);
        }
        for(const side of [-1,1])for(let z=a.z-a.depth/2+2;z<a.z+a.depth/2;z+=4){
          b.box(glass,[a.x+side*(a.width/2+.035),y+floorHeight*.57,z],[.08,floorHeight*.54,2.5]);
          b.box(white,[a.x+side*(a.width/2+.08),y+floorHeight*.57,z],[.10,floorHeight*.56,.07]);
        }
      }
      for(const side of [-1,1])for(const end of [-1,1])
        b.box(white,[a.x+side*(a.width/2+.15),a.height/2,a.z+end*(a.depth/2+.15)],[.4,a.height,.4]);
      const roof=central?purple:green;
      b.roof(roof,a.x,a.z,a.width+1.8,a.depth+1.8,a.height+.18,central?2.8:2.1);
      b.box(white,[a.x,a.height+.08,a.z],[a.width+1.8,.18,a.depth+1.8]);
      // Framed main entrance, apron and three shallow access steps.
      b.box(glass,[a.x,1.45,a.z+a.depth/2+.09],[3,2.9,.12]);
      b.box(white,[a.x,1.45,a.z+a.depth/2+.18],[.08,2.9,.12]);
      for(let i=0;i<3;i++)b.box(white,[a.x,.06+i*.06,a.z+a.depth/2+.5+(2-i)*.35],[4.4,.12+i*.12,.9]);
    }
    // The central car park stays entirely empty, with two clearly marked rows.
    b.box(pavement,[-63,.035,52],[54,.10,18]);
    for(const z of [44.5,59.5])for(let x=-88;x<=-38;x+=3)
      b.box(paint,[x,.10,z],[.10,.018,4.5],Math.PI/6);
    for(const z of [42.5,61.5])b.box(paint,[-63,.10,z],[53,.018,.12]);
    function shelter(x:number,z:number,width:number,depth:number){
      b.roof(orange,x,z,width,depth,3.5,.8);
      for(let dx=-width/2+1;dx<width/2;dx+=5)for(const side of [-1,1])
        b.box(white,[x+dx,1.75,z+side*(depth/2-.5)],[.16,3.5,.16]);
    }
    shelter(-176,-57,26,7);
    // Stop either side of the calibrated north-south pedestrian route at X=-66.
    shelter(-80,37,22,4);shelter(-50,37,24,4);
    return b.build();
  },[]);
  useEffect(()=>()=>model.dispose(),[model]);
  return <primitive object={model.group} dispose={null} />;
}
