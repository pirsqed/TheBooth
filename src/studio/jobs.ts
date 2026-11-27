import * as crypto from 'node:crypto';

export type JobKind = 'render_all' | 'mix' | 'direct_project' | 'index_assets';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface JobErrorItem {
  targetId: string;
  message: string;
}

export interface StudioJob {
  id: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  total: number;
  completed: number;
  failed: number;
  errors: JobErrorItem[];
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}

export class JobTracker {
  private readonly jobs = new Map<string, StudioJob>();

  hasActiveJobs(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') return true;
    }
    return false;
  }

  create(projectId: string, kind: JobKind, total: number): StudioJob {
    const now = new Date().toISOString();
    const job: StudioJob = {
      id: `job_${crypto.randomBytes(6).toString('hex')}`,
      projectId,
      kind,
      status: 'queued',
      total,
      completed: 0,
      failed: 0,
      errors: [],
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }

  get(jobId: string): StudioJob | null {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  update(jobId: string, patch: Partial<StudioJob>): StudioJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return structuredClone(job);
  }

  incrementCompleted(jobId: string): StudioJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    job.completed += 1;
    job.updatedAt = new Date().toISOString();
    return structuredClone(job);
  }

  recordError(jobId: string, targetId: string, message: string): StudioJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    job.failed += 1;
    job.errors.push({ targetId, message });
    job.updatedAt = new Date().toISOString();
    return structuredClone(job);
  }
}
