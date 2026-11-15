import { newEvent } from './events.js';
import { parseReview, type ReviewRecord } from '../domain/reviews.js';
import type { GoalRepository } from '../ports/goal-repository.js';

export class ReviewService {
  constructor(private readonly store: GoalRepository) {}

  submit(goalId: string, value: unknown): ReviewRecord {
    const review = parseReview(value);
    this.store.append(newEvent(goalId, 'review-submitted', review));
    return review;
  }
}
