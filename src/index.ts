import { codeSwarmPlugin } from "./register.js";

export default codeSwarmPlugin;
export { buildCommandDefinitions } from "./commands.js";
export { getPackageRoot, loadDefaultConfig } from "./defaults.js";
export { resolveCodeSwarmConfig } from "./overrides.js";
export { formatCompactionContext, formatStateSummary } from "./register.js";
export {
  approveCodeSwarmTransition,
  createDefaultState,
  forceCodeSwarmPhase,
  proposeCodeSwarmTransition,
  readCodeSwarmState,
  resetCodeSwarmState,
} from "./state.js";
export type {
  CodeSwarmDefaults,
  CodeSwarmPluginOptions,
  CodeSwarmProjectOverrides,
  CodeSwarmState,
  Phase,
  ResolvedCodeSwarmConfig,
  ResolvedRoleConfig,
  RoleDefaults,
  RoleName,
  TransitionHistoryEntry,
} from "./types.js";
