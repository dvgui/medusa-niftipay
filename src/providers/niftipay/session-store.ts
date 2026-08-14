import type { Logger } from "@medusajs/framework/types"

export type NiftipaySessionRow = {
  id: string
  status?: string | null
  amount?: number | string | null
  currency_code?: string | null
  provider_id?: string | null
  data?: Record<string, unknown> | null
  deleted_at?: string | Date | null
}

const safeResolve = <T>(
  container: Record<string, unknown>,
  keys: readonly string[],
): T | undefined => {
  for (const key of keys) {
    try {
      const value = container[key]
      if (value != null) return value as T
    } catch {
      // Awilix cradle proxies throw for unknown registrations.
    }
  }
  return undefined
}

const FIELDS = [
  "id",
  "status",
  "amount",
  "currency_code",
  "provider_id",
  "data",
  "deleted_at",
]

export class NiftipaySessionStore {
  constructor(
    private readonly container: Record<string, unknown>,
    private readonly logger: Logger,
  ) {}

  private service() {
    return safeResolve<{
      retrieve?: (
        id: string,
        config?: unknown,
      ) => Promise<NiftipaySessionRow>
      list?: (
        filters: unknown,
        config?: unknown,
      ) => Promise<NiftipaySessionRow[]>
      update?: (input: unknown) => Promise<unknown>
    }>(this.container, ["paymentSessionService", "paymentSession"])
  }

  async load(sessionId: string): Promise<NiftipaySessionRow | null> {
    const service = this.service()
    if (service?.retrieve) {
      try {
        return await service.retrieve(sessionId, { select: FIELDS })
      } catch {
        // Fall through to Query when the internal service isn't in this scope.
      }
    }

    const query = safeResolve<{
      graph?: (input: unknown) => Promise<{ data: unknown[] }>
    }>(this.container, ["query", "__query__", "remoteQuery"])
    if (!query?.graph) return null

    const { data } = await query.graph({
      entity: "payment_session",
      fields: FIELDS,
      filters: { id: sessionId },
    })
    return (data[0] as NiftipaySessionRow | undefined) ?? null
  }

  async findByOrderKey(orderKey: string): Promise<NiftipaySessionRow | null> {
    const service = this.service()
    if (!service?.list) return null

    const sessions = await service.list(
      { status: ["pending", "authorized", "captured"] },
      { take: 100, order: { created_at: "DESC" }, select: FIELDS },
    )
    return (
      sessions.find(
        (session) =>
          String(session.provider_id ?? "").includes("niftipay") &&
          String(session.data?.niftipay_order_key ?? "") === orderKey,
      ) ?? null
    )
  }

  async stamp(
    session: NiftipaySessionRow,
    patch: Record<string, unknown>,
  ): Promise<void> {
    try {
      const service = this.service()
      if (!service?.update) return
      await service.update({
        id: session.id,
        data: { ...(session.data ?? {}), ...patch },
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(
        `[niftipay] could not stamp payment session ${session.id}: ${message}`,
      )
    }
  }
}
