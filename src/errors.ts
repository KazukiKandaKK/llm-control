export class QueueTimeoutError extends Error {
  constructor(message = "Admission queue timeout") {
    super(message);
    this.name = "QueueTimeoutError";
  }
}

export class QueueOverflowError extends Error {
  constructor(message = "Admission queue overflow") {
    super(message);
    this.name = "QueueOverflowError";
  }
}
