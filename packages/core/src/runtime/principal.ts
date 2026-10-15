// Continuation state is bound to these identifiers; credentials stay with the host.
export interface ExecutionPrincipal {
  readonly accountId: string;
  readonly subject: string;
}
