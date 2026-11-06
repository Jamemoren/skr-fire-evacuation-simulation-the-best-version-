import { useEffect, useMemo } from "react";
import { SITE_BOUNDARY } from "./siteLayout";
import { siteGeometry } from "./staticSiteGeometry";

export function SiteGround() {
  const model=useMemo(()=>{
    const b=siteGeometry("PAVED_CAMPUS_AND_WHITE_PERIMETER");
    const concrete=b.finish("Gray concrete site paving","#aeb2b1");
    const joint=b.finish("Concrete expansion joints","#9da3a3",true);
    const wall=b.finish("White concrete perimeter walls","#f0eee6");
    const cap=b.finish("Wall coping and gate piers","#fffaf0");
    const garden=b.finish("Small landscaped beds","#5d8054");
    // Non-overlapping paved rectangles follow the reference's stepped site boundary.
    const plots=[[-296,-160,-66,6],[-160,34,-66,0],[-160,62,0,70],[-34,62,70,178]];
    for(const [x0,x1,z0,z1] of plots){
      b.box(concrete,[(x0+x1)/2,-.15,(z0+z1)/2],[x1-x0,.26,z1-z0]);
      for(let x=x0+12;x<x1;x+=12)b.box(joint,[x,-.005,(z0+z1)/2],[.025,.01,z1-z0]);
      for(let z=z0+12;z<z1;z+=12)b.box(joint,[(x0+x1)/2,-.005,z],[x1-x0,.01,.025]);
    }
    function segment(ax:number,az:number,bx:number,bz:number){
      const length=Math.hypot(bx-ax,bz-az),yaw=Math.atan2(-(bz-az),bx-ax);
      b.box(wall,[(ax+bx)/2,.60,(az+bz)/2],[length,1.24,.28],yaw);
      b.box(cap,[(ax+bx)/2,1.26,(az+bz)/2],[length+.10,.12,.36],yaw);
      const n=Math.max(1,Math.ceil(length/12));
      for(let i=0;i<=n;i++)b.box(cap,[ax+(bx-ax)*i/n,.69,az+(bz-az)*i/n],[.43,1.42,.43]);
    }
    for(let i=0;i<SITE_BOUNDARY.length;i++){
      const [ax,az]=SITE_BOUNDARY[i], [bx,bz]=SITE_BOUNDARY[(i+1)%SITE_BOUNDARY.length];
      // Open gates line up with the bus road and the east service approach.
      if(ax===-296&&bx===-296){segment(ax,az,bx,-36);segment(ax,-50,bx,bz);}
      else if(ax===62&&bx===62){segment(ax,az,bx,39);segment(ax,51,bx,bz);}
      else segment(ax,az,bx,bz);
    }
    b.box(concrete,[46.8,.035,45],[30.4,.1,12]);
    b.box(garden,[-78,.015,-5],[28,.06,9]);
    b.box(garden,[-24,.015,-18],[69,.06,4]);
    return b.build();
  },[]);
  useEffect(()=>()=>model.dispose(),[model]);
  return <primitive object={model.group} dispose={null} />;
}
