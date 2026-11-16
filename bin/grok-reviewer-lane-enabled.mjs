import { grokReviewerLaneEnabled } from '../src/grok-reviewer-lane.mjs';

process.exitCode = grokReviewerLaneEnabled() ? 0 : 1;
