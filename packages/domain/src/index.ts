/**
 * Framework-independent domain seam.
 *
 * M0/M1 intentionally keep orchestration out of this package. Later milestones
 * will add canonical models, state machines, policies, commands, and events.
 */
export type TenantId = string;

export type DomainClock = {
  now(): string;
};
