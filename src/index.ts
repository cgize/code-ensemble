import { codeEnsemblePlugin } from "./register.js";

export default codeEnsemblePlugin;
export { buildCommandDefinitions } from "./commands.js";
export { getPackageRoot, loadDefaultConfig } from "./defaults.js";
export { resolveCodeEnsembleConfig } from "./overrides.js";
export { formatCompactionContext, formatStateSummary } from "./register.js";
export {
  approveCodeEnsembleTransition,
  createDefaultState,
  forceCodeEnsemblePhase,
  proposeCodeEnsembleTransition,
  readCodeEnsembleState,
  resetCodeEnsembleState,
  setCodeEnsembleAutoLoop,
} from "./state.js";
export type {
  CodeEnsembleDefaults,
  CodeEnsemblePluginOptions,
  CodeEnsembleProjectOverrides,
  CodeEnsembleState,
  Phase,
  ResolvedCodeEnsembleConfig,
  ResolvedRoleConfig,
  RoleDefaults,
  RoleName,
  TransitionHistoryEntry,
} from "./types.js";
