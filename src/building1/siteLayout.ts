import type { Vec3 } from "../types";

/** Versioned site coordinates shared by geometry, routing and saved-map upgrades. */
export interface SiteLayout {
  fieldCenter: Vec3;
  fieldRotated: boolean;
  fieldSize: Vec3;
  campusWalkX: number;
  parkingZones: Vec3[];
  buildingX: Record<3 | 4, number>;
}

export const PREVIOUS_SITE_LAYOUT: SiteLayout = {
  fieldCenter: [-3, 0, 92], fieldRotated: false, fieldSize: [104, .5, 62],
  campusWalkX: -74,
  buildingX: { 3: -20, 4: -112 },
  parkingZones: [-5, 25, 55].map(z => [-194, .22, z] as Vec3),
};

export const SITE_LAYOUT: SiteLayout = {
  fieldCenter: [-3, 0, 119], fieldRotated: true, fieldSize: [62, .5, 104],
  campusWalkX: -66,
  buildingX: { 3: -112, 4: -20 },
  parkingZones: [-268, -230, -192].map(x => [x, .22, -12] as Vec3),
};

export const PARKING_ROAD = { x: -230, z: -43, length: 124, width: 24 };
export const PARKING_PLAZA = { x: -230, z: -12, width: 124, depth: 32 };
export const SHRINE_CENTER: Vec3 = [-108, 0, 16];
export const SHRINE_FOCUS: Vec3 = [-108, 4.5, 16];
export const SHRINE_CLEARANCE_RADIUS = 18.1;
export const SHRINE_ROTATION_Y = -Math.PI / 2;
export const SITE_BOUNDARY: Array<[number,number]> = [
  [-296,-66],[34,-66],[34,-18],[62,-18],[62,178],[-34,178],
  [-34,70],[-160,70],[-160,6],[-296,6],
];
/** Context buildings; no invented occupant counts or unprovided evacuation plans. */
export const CAMPUS_AMENITIES = [
  {id:"campus-central-building",name:"อาคารกลาง",x:-78,z:16,width:20,depth:28,height:13.3},
  {id:"campus-east-hall",name:"อาคารประกอบฝั่งสนาม",x:49,z:113,width:23,depth:44,height:8.2},
  {id:"campus-east-annex",name:"อาคารประกอบด้านใต้",x:49,z:159,width:23,depth:27,height:7.2},
];

export function fieldOffset(x: number, y: number, z: number, layout = SITE_LAYOUT): Vec3 {
  return layout.fieldRotated ? [z, y, -x] : [x, y, z];
}

export function fieldPoint(x: number, y: number, z: number, layout = SITE_LAYOUT): Vec3 {
  const offset = fieldOffset(x, y, z, layout);
  return [layout.fieldCenter[0] + offset[0], offset[1], layout.fieldCenter[2] + offset[2]];
}

export function parkingApproach(goal: Vec3, layout = SITE_LAYOUT): Vec3[] {
  return layout.fieldRotated ? [[-166, .22, -25], [goal[0], .22, -25]] : [[-194, .22, -25]];
}
