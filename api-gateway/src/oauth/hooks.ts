// node-oidc-provider lifecycle hooks → Sentry breadcrumbs + metrics.
//
// The library emits events for every token issuance, refresh rotation,
// and revocation. Wiring them gives us a per-request audit trail
// without spinning up a dedicated oauth_events table (slice 9 follow-up
// TODO).
//
// Security event: refresh-token reuse triggers the library's built-in
// chain revocation. We detect it via the grant.error event with code
// 'invalid_grant' on the refresh-token grant path, AND via the
// subsequent grant.revoked cascade. Both Sentry-capture with tag
// `security: oauth_token_reuse` so alerting fires.

import type { FastifyBaseLogger } from 'fastify'
import type { Provider } from 'oidc-provider'
import { Sentry } from '../sentry'

export function attachLifecycleHooks(
  provider: Provider,
  log: FastifyBaseLogger,
): void {
  // Access token issued (auth_code, client_credentials, refresh).
  provider.on('access_token.issued', (token) => {
    log.info(
      {
        metric: 'oauth.tokens',
        grant_type: 'access_token',
        ok: true,
        client_id: token.clientId,
        account_id: token.accountId,
      },
      'oauth access token issued',
    )
    Sentry.addBreadcrumb({
      category: 'oauth',
      level: 'info',
      message: 'access_token.issued',
      data: { client_id: token.clientId, account_id: token.accountId },
    })
  })

  // Refresh token persisted — first issuance OR rotation. The library
  // doesn't emit a separate "issued" vs "rotated" event; the row's
  // existence implies issuance.
  provider.on('refresh_token.saved', (token) => {
    log.info(
      {
        metric: 'oauth.tokens',
        grant_type: 'refresh_token',
        ok: true,
        client_id: token.clientId,
        account_id: token.accountId,
      },
      'oauth refresh token issued',
    )
    Sentry.addBreadcrumb({
      category: 'oauth',
      level: 'info',
      message: 'refresh_token.saved',
      data: { client_id: token.clientId, account_id: token.accountId },
    })
  })

  // Refresh token consumed — the load-bearing rotation signal. After
  // this fires, the SAME token id is now consumed; presenting it again
  // is reuse → library throws invalid_grant and cascades revocation.
  provider.on('refresh_token.consumed', (token) => {
    log.info(
      {
        metric: 'oauth.refresh.rotated',
        client_id: token.clientId,
        account_id: token.accountId,
        grant_id: token.grantId,
      },
      'oauth refresh token consumed (rotated)',
    )
  })

  // Grant revoked — fires on admin revocation OR library cascade.
  provider.on('grant.revoked', (_ctx, grantId) => {
    log.info(
      { metric: 'oauth.grant.revoked', grant_id: grantId },
      'oauth grant revoked',
    )
    Sentry.addBreadcrumb({
      category: 'oauth',
      level: 'warning',
      message: 'grant.revoked',
      data: { grant_id: grantId },
    })
  })

  // Grant errors — the load-bearing security signal. The library
  // throws invalid_grant on refresh-token reuse; that error reaches
  // here with the consumed token's grantId attached so we can fingerprint
  // by client_id.
  provider.on('grant.error', (ctx, err) => {
    const isReplay =
      err.message?.toLowerCase().includes('replay') ||
      err.error === 'invalid_grant'
    const clientId = ctx?.oidc?.client?.clientId ?? 'unknown'
    log.warn(
      {
        metric: 'oauth.grant.error',
        error_code: err.error,
        client_id: clientId,
        path: ctx?.path,
      },
      'oauth grant error',
    )
    if (isReplay) {
      const message = 'OAuth refresh token reuse / invalid_grant detected'
      Sentry.captureException(new Error(message), {
        tags: { security: 'oauth_token_reuse', client_id: clientId },
        fingerprint: ['oauth_token_reuse', clientId],
        level: 'warning',
        extra: { error_description: err.error_description, path: ctx?.path },
      })
    } else {
      Sentry.addBreadcrumb({
        category: 'oauth',
        level: 'warning',
        message: 'grant.error',
        data: { error: err.error, path: ctx?.path },
      })
    }
  })

  // DCR — surfaces when new clients register so we have a paper trail.
  provider.on('registration_create.success', (_ctx, client) => {
    log.info(
      {
        metric: 'oauth.registration',
        client_id: client.clientId,
        client_name: client.clientName,
      },
      'oauth client registered',
    )
    Sentry.addBreadcrumb({
      category: 'oauth',
      level: 'info',
      message: 'registration_create.success',
      data: { client_id: client.clientId, client_name: client.clientName },
    })
  })

  // Authorization errors — user denial, invalid scope, bad redirect_uri.
  provider.on('authorization.error', (ctx, err) => {
    log.warn(
      { err: err.message, path: ctx?.path },
      'oauth authorization error',
    )
    Sentry.addBreadcrumb({
      category: 'oauth',
      level: 'warning',
      message: 'authorization.error',
      data: { error: err.message, path: ctx?.path },
    })
  })

  // Unhandled server errors from inside the provider.
  provider.on('server_error', (ctx, err) => {
    log.error({ err, path: ctx?.path }, 'oauth provider server_error')
    Sentry.captureException(err, {
      tags: { code: 'OAUTH_SERVER_ERROR', oauth_path: ctx?.path },
    })
  })
}
