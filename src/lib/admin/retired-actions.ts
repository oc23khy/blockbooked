export const retiredAdminActions = [
  "adminRefund",
  "retryProviderTransfer",
  "updateCommission",
  "retryExpirationRefund",
  "resolveCompletionReview",
] as const;

export type RetiredAdminAction = (typeof retiredAdminActions)[number];

export class RetiredAdminActionError extends Error {
  readonly action: string;

  constructor(action: string) {
    super(`The administrator action "${action}" is disabled.`);
    this.name = "RetiredAdminActionError";
    this.action = action;
  }
}

export function invokeRetiredAdminAction(action: RetiredAdminAction, role: string | null | undefined): never {
  void role;
  throw new RetiredAdminActionError(action);
}
