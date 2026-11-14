import { randomUUID } from 'node:crypto';
import { parseReview, type ReviewRecord } from '../domain/reviews.js';
import type { GoalRepository } from '../store/journal.js';

export class ReviewService {
  constructor(private readonly store: GoalRepository) {}

  submit(goalId: string, value: unknown): ReviewRecord {
    const review = parseReview(value);
    this.store.append({
      id: randomUUID(),
      goalId,
      type: 'review-submitted',
      data: review,
      at: new Date().toISOString(),
    });
    return review;
  }
}
