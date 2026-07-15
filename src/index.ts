import { codeEnsemblePlugin } from "./register.js";

const plugin = {
  id: "@cgize/code-ensemble",
  server: codeEnsemblePlugin,
};

export default plugin;
export { plugin, plugin as codeEnsemblePlugin };
export type { Plugin } from "@opencode-ai/plugin";
