// Thin facade — logic lives in containerPresets, containerDocker, and containerTasks.
// This file kept for backward compatibility with existing imports.

export type { ContainerRecord, CustomContainerRequest, RuntimePreset } from "./containerPresets.js";
export { presets, presetForKey } from "./containerPresets.js";

export { cleanupFailedManagedContainers, dockerContainers, imageExists } from "./containerDocker.js";

export {
  createCustomContainerTask,
  createImagePullTask,
  createImageTestTask,
  createRuntimeStartTestTask,
  listContainers,
  applyContainerRuntimeConfig,
  containerLogs,
  containerAction,
  deleteContainer,
} from "./containerTasks.js";
