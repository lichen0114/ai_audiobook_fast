import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';

import type { BatchPlan } from '../types/profile.js';

interface BatchReviewProps {
    plan: BatchPlan;
    onStart: () => void;
    onStartFreshAll: () => void;
    onBack: () => void;
}

export function BatchReview({ plan, onStart, onStartFreshAll, onBack }: BatchReviewProps) {
    const readyJobs = plan.jobs.filter((job) => !job.errors.length && !job.blocked);
    const errorJobs = plan.jobs.filter((job) => job.errors.length > 0);
    const blockedJobs = plan.jobs.filter((job) => job.blocked);

    const actions = [
        {
            label: blockedJobs.length > 0
                ? `▶ Start ready jobs (${readyJobs.length}) and skip blocked ones`
                : `▶ Start batch (${readyJobs.length} job${readyJobs.length === 1 ? '' : 's'})`,
            value: 'start',
        },
        ...(plan.resumableJobs > 0 ? [{
            label: `↺ Start fresh for all resumable jobs (${plan.resumableJobs})`,
            value: 'fresh',
        }] : []),
        {
            label: '← Back to configuration',
            value: 'back',
        },
    ];

    return (
        <Box flexDirection="column" paddingX={2}>
            <Box marginBottom={1}>
                <Text color="cyan" bold>Batch Review</Text>
            </Box>

            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="gray"
                paddingX={2}
                paddingY={1}
                marginBottom={1}
            >
                <Text bold color="white">Summary</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text>Files: <Text color="cyan">{plan.jobs.length}</Text></Text>
                    <Text>Ready to run: <Text color="green">{readyJobs.length}</Text></Text>
                    <Text>Resumable: <Text color="yellow">{plan.resumableJobs}</Text></Text>
                    <Text>Warnings: <Text color={plan.warningCount > 0 ? 'yellow' : 'gray'}>{plan.warningCount}</Text></Text>
                    <Text>Errors: <Text color={errorJobs.length > 0 ? 'red' : 'gray'}>{errorJobs.length}</Text></Text>
                    <Text>Blocked collisions: <Text color={blockedJobs.length > 0 ? 'red' : 'gray'}>{blockedJobs.length}</Text></Text>
                    <Text>Total chars: <Text color="cyan">{plan.totalChars.toLocaleString()}</Text></Text>
                    <Text>Total chunks: <Text color="cyan">{plan.totalChunks.toLocaleString()}</Text></Text>
                </Box>
            </Box>

            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="cyan"
                paddingX={2}
                paddingY={1}
                marginBottom={1}
            >
                <Text bold color="white">Jobs</Text>
                <Box marginTop={1} flexDirection="column">
                    {plan.jobs.slice(0, 8).map((job) => (
                        <Box key={job.id} flexDirection="column" marginBottom={1}>
                            <Box>
                                <Text color={job.blocked ? 'red' : job.errors.length > 0 ? 'red' : 'green'}>
                                    {job.blocked ? '!' : job.errors.length > 0 ? '✘' : '•'}
                                </Text>
                                <Text> </Text>
                                <Text bold>{job.metadata.title}</Text>
                                <Text dimColor> • </Text>
                                <Text dimColor>{job.estimate.totalChars.toLocaleString()} chars</Text>
                                <Text dimColor> • </Text>
                                <Text dimColor>{job.estimate.totalChunks} chunks</Text>
                            </Box>
                            <Box marginLeft={2}>
                                <Text dimColor>{job.inputPath}</Text>
                            </Box>
                            <Box marginLeft={2}>
                                <Text dimColor>Output: </Text>
                                <Text color="cyan">{job.outputPath}</Text>
                            </Box>
                            <Box marginLeft={2}>
                                <Text dimColor>Checkpoint: </Text>
                                <Text color={job.checkpoint.action === 'resume' ? 'yellow' : 'gray'}>
                                    {job.checkpoint.action === 'resume'
                                        ? `resume ${job.checkpoint.completedChunks ?? 0}/${job.checkpoint.totalChunks ?? 0}`
                                        : job.checkpoint.action}
                                </Text>
                            </Box>
                            {job.warnings[0] && (
                                <Box marginLeft={2}>
                                    <Text color="yellow">Warning: {job.warnings[0]}</Text>
                                </Box>
                            )}
                            {job.errors[0] && (
                                <Box marginLeft={2}>
                                    <Text color="red">Error: {job.errors[0]}</Text>
                                </Box>
                            )}
                        </Box>
                    ))}
                    {plan.jobs.length > 8 && (
                        <Text dimColor>... and {plan.jobs.length - 8} more</Text>
                    )}
                </Box>
            </Box>

            <SelectInput
                items={actions}
                onSelect={(item) => {
                    if (item.value === 'start') {
                        onStart();
                        return;
                    }
                    if (item.value === 'fresh') {
                        onStartFreshAll();
                        return;
                    }
                    onBack();
                }}
            />
        </Box>
    );
}
