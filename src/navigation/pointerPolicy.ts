/** Mouse look uses the right button; touch and primary pen gestures stay available. */
export function canStartCameraLook(pointerType: string, button: number): boolean {
  return pointerType === "mouse" ? button === 2 : button === 0;
}

/** A second finger or another mouse button must not release the active gesture. */
export function canEndPointerGesture(owner: { id: number; button: number } | null, event: { pointerId: number; button: number; type: string }): boolean {
  return owner !== null && owner.id === event.pointerId && (event.type !== "pointerup" || event.button === owner.button);
}

export function releasePointerCapture(element: Pick<Element, "hasPointerCapture" | "releasePointerCapture">, id: number) {
  if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
}
