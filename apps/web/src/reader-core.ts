type ExplanationPanelModule = typeof import("./ExplanationPanel.js");
let load: Promise<ExplanationPanelModule> | undefined;

export function preloadExplanationPanel(): Promise<ExplanationPanelModule> {
  return load ??= import("./ExplanationPanel.js");
}
