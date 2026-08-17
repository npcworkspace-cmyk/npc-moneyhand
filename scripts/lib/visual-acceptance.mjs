export function resolveFixtureImagePoint({
  desk,
  capture,
  screenPoint,
  targetBounds,
  coordinateSpace,
}) {
  const mapping = capture?.mapping?.imageToScreen;
  const image = capture?.image;
  const valid = typeof desk?.resolveWindowCapturePoint === "function"
    && mapping
    && image
    && [mapping.originX, mapping.originY, mapping.scaleX, mapping.scaleY].every(Number.isFinite)
    && mapping.scaleX > 0
    && mapping.scaleY > 0
    && Number.isInteger(image.width)
    && Number.isInteger(image.height)
    && image.width > 0
    && image.height > 0
    && capture.mapping.coordinateSpace === coordinateSpace
    && [screenPoint?.x, screenPoint?.y].every(Number.isFinite)
    && [targetBounds?.x, targetBounds?.y, targetBounds?.width, targetBounds?.height]
      .every(Number.isFinite)
    && targetBounds.width > 0
    && targetBounds.height > 0;
  if (!valid) throw new Error("Exact-window capture mapping is unusable");

  const imageX = Math.max(0, Math.min(
    image.width - 1,
    Math.floor((screenPoint.x - mapping.originX) / mapping.scaleX),
  ));
  const imageY = Math.max(0, Math.min(
    image.height - 1,
    Math.floor((screenPoint.y - mapping.originY) / mapping.scaleY),
  ));
  const resolved = desk.resolveWindowCapturePoint({
    captureId: capture.id,
    imageX,
    imageY,
  });
  const mappedInsideTarget = resolved.screenPoint.x >= targetBounds.x
    && resolved.screenPoint.y >= targetBounds.y
    && resolved.screenPoint.x < targetBounds.x + targetBounds.width
    && resolved.screenPoint.y < targetBounds.y + targetBounds.height;
  if (!mappedInsideTarget) {
    throw new Error("Capture image pixel does not resolve inside the fixture target bounds");
  }
  return resolved;
}
