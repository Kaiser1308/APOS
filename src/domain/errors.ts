/** An input or precondition mistake by the user; its message is shown to the user as is. */
export class UserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UserError';
  }
}

/** A rule that must always hold was violated; this is a defect, not a user mistake. */
export class InvariantError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvariantError';
  }
}
