import type { BatchJobPlan } from '../types/profile.js';

export interface BatchSchedulerHandlers {
    onJobStart: (job: BatchJobPlan, index: number) => Promise<void> | void;
    runJob: (job: BatchJobPlan, index: number) => Promise<void>;
    onJobSuccess: (job: BatchJobPlan, index: number) => Promise<void> | void;
    onJobError: (job: BatchJobPlan, index: number, error: unknown) => Promise<void> | void;
    onJobSkipped?: (job: BatchJobPlan, index: number) => Promise<void> | void;
}

export async function runBatchScheduler(
    jobs: BatchJobPlan[],
    handlers: BatchSchedulerHandlers,
): Promise<void> {
    for (const [index, job] of jobs.entries()) {
        const shouldSkip = job.blocked || job.errors.length > 0;
        if (shouldSkip) {
            await handlers.onJobSkipped?.(job, index);
            continue;
        }

        await handlers.onJobStart(job, index);
        try {
            await handlers.runJob(job, index);
            await handlers.onJobSuccess(job, index);
        } catch (error) {
            await handlers.onJobError(job, index, error);
        }
    }
}
