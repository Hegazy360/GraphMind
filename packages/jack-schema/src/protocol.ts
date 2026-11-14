/**
 * The one MCP revision Jack speaks. Decided 2026-11-08: no users yet, so no
 * legacy (2025-era) serving — the handler runs with `legacy: 'reject'`.
 * When the spec revises, this constant and the conformance suite move together.
 */
export const PROTOCOL_VERSION = '2026-07-28' as const;

export const SERVICE = 'jack' as const;
