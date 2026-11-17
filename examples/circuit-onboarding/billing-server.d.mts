// Types for billing-server.mjs, so TypeScript embedders (the hosted site,
// circuit-mcp's tests) can import the factory under strict settings.
import type { McpServer } from '@modelcontextprotocol/server';

export declare function createBillingServer(): McpServer;
