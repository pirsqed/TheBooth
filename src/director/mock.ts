import {
  DirectorReviewer,
  DirectorReviewRequest,
  DirectorReviewVerdict,
} from './interface.js';

export interface MockDirectorReviewerOptions {
  /** Zero-based attempt number on which to approve (default 1 = reject take 1, approve retake 2). Set Infinity to always reject. */
  approveOnAttempt?: number;
  /** Optional custom callback for full test control */
  decide?: (req: DirectorReviewRequest) => DirectorReviewVerdict | Promise<DirectorReviewVerdict>;
}

/**
 * Deterministic zero-cost Director reviewer for automated tests and offline development.
 */
export class MockDirectorReviewer implements DirectorReviewer {
  readonly name = 'mock-director';
  private readonly approveOnAttempt: number;
  private readonly decide?: MockDirectorReviewerOptions['decide'];

  constructor(options: MockDirectorReviewerOptions = {}) {
    this.approveOnAttempt = options.approveOnAttempt ?? 1;
    this.decide = options.decide;
  }

  async reviewTake(req: DirectorReviewRequest): Promise<DirectorReviewVerdict> {
    if (this.decide) {
      return this.decide(req);
    }

    if (req.attempt >= this.approveOnAttempt) {
      return {
        approved: true,
        score: 8.5,
        feedback: `Take ${req.attempt + 1} nailed the pacing and warmth (${req.persona ?? 'default'} persona).`,
        suggestedDirection: null,
        suggestedText: null,
        suggestedMixPatch: null,
      };
    }

    return {
      approved: false,
      score: 5.5 + req.attempt * 0.5,
      feedback: `Take ${req.attempt + 1} felt slightly brisk; soften and slow down on retake.`,
      suggestedDirection: 'slower, softer, warm close-mic whisper',
      suggestedText: null,
      suggestedMixPatch: null,
    };
  }
}
