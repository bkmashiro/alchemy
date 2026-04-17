// src/executors/index.ts
// Stub barrel file — Agent A implements the actual executors.

export { BaseExecutor } from './base.js';
export type { SubmitResult, StatusResult } from './base.js';

// NOTE: SlurmSSHExecutor and LocalExecutor are implemented by Agent A.
// Self-registration of executors happens in their respective files.
