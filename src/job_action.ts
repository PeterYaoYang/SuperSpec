// SuperSpec workflow engine - shared job action protocol helpers.

import type { Job, RequiredJobAction } from "./types.ts";

export function jobPacketCommand(change: string, jobId: string): string {
  return `superspec jobs packet --change "${change}" --job "${jobId}"`;
}

export function jobPacketArgv(change: string, jobId: string): string[] {
  return ["superspec", "jobs", "packet", "--change", change, "--job", jobId];
}

export function jobDispatchCommand(change: string, jobId: string): string {
  return `superspec jobs dispatch --change "${change}" --job "${jobId}"`;
}

export function jobDispatchArgv(change: string, jobId: string): string[] {
  return ["superspec", "jobs", "dispatch", "--change", change, "--job", jobId];
}

export function requiredJobAction(change: string, job: Job): RequiredJobAction {
  return {
    job_id: job.job_id,
    role: job.role,
    packet_command: jobPacketCommand(change, job.job_id),
    packet_argv: jobPacketArgv(change, job.job_id),
    dispatch_command: jobDispatchCommand(change, job.job_id),
    dispatch_argv: jobDispatchArgv(change, job.job_id),
  };
}

export function requiredJobActions(change: string, jobs: Job[]): RequiredJobAction[] {
  return jobs.map(job => requiredJobAction(change, job));
}

export function jobSubmitArgv(change: string, jobId: string): string[] {
  return ["superspec", "record", "job-submit", "--change", change, "--job", jobId, "--report", "-"];
}
