/** Thai display names for the few graph places still named in English (the graph ids stay as they are). */
const PLACE_NAMES_TH: Record<string, string> = {
  "Assembly Gate Left": "ประตูสนาม ฝั่งซ้าย",
  "Assembly Gate Center": "ประตูสนาม ตรงกลาง",
  "Assembly Gate Right": "ประตูสนาม ฝั่งขวา",
};

export const placeNameTh = (name: string) => PLACE_NAMES_TH[name] ?? name;
