/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-account-postgres`.
 * @module @deepseek-ai/dsh-account-postgres/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-account-postgres'

/** Cordis companion plugin name. */
export const name = 'account-postgres-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: durable Account and Sign-in session rows are owned
 * by PostgreSQL; HTTP tests observe cookie and JSON effects, not table
 * contents.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
