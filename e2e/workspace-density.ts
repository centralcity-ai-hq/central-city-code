/*
 * The signed-in workspace is drawn at 90% on wider screens (src/shell/tokens.css, "Workspace
 * density"). Phones (640 px and narrower) keep full-size spacing and controls, so their touch
 * targets stay 44 px.
 */
export const WORKSPACE_SCALE = 0.9;

/** The workspace's scale at a viewport width: 1 on phones, 0.9 on wider screens. */
export function workspaceScale(width: number) {
  return width <= 640 ? 1 : WORKSPACE_SCALE;
}

/** The smallest control height or width the workspace allows at a viewport width (44 px on
 * phones; 44 px at 90%, about 39.6 px, on wider screens). Half a pixel absorbs rounding. */
export function workspaceTarget(width: number) {
  return width <= 640 ? 44 : 44 * WORKSPACE_SCALE - 0.5;
}
