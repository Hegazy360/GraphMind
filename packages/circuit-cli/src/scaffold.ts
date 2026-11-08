/**
 * Workflow templates for `circuit dev`'s "New workflow" button (and anyone
 * who wants a starting point). scaffoldWorkflow appends the chosen template
 * to the loaded workflows file; the dev watcher hot-reloads it from there.
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const camel = (kebabName: string): string => kebabName.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

export const TEMPLATES: Record<string, { label: string; code: (name: string) => string }> = {
  blank: {
    label: 'Blank: one step',
    code: (name) => `export const ${camel(name)} = workflow(
  { name: '${name}', input: z.object({}) },
  async (ctx, input) => {
    const result = await ctx.step('first-step', () => {
      return 'hello from ${name}';
    });
    return { result };
  },
);`,
  },
  approval: {
    label: 'Human approval gate',
    code: (name) => `export const ${camel(name)} = workflow(
  { name: '${name}', input: z.object({ subject: z.string() }) },
  async (ctx, input) => {
    const prepared = await ctx.step('prepare', () => ({ subject: input.subject, at: new Date().toISOString() }));
    const signoff = await ctx.approval('sign-off', { approvers: ['role:lead'], timeout: '48h', context: prepared });
    if (!signoff.approved) return { status: 'rejected', by: signoff.by ?? 'timeout' };
    await ctx.step('apply', () => {
      // the approved action goes here
      return true;
    });
    return { status: 'applied', by: signoff.by };
  },
);`,
  },
  event: {
    label: 'Wait for an external event',
    code: (name) => `export const ${camel(name)} = workflow(
  { name: '${name}', input: z.object({ orderId: z.string() }) },
  async (ctx, input) => {
    await ctx.step('register', () => ({ registered: input.orderId }));
    // deliver with: POST /v1/events {"name":"order.shipped","data":{"orderId":"..."}}
    const shipped = await ctx.waitForEvent('shipment', {
      name: 'order.shipped',
      match: { orderId: input.orderId },
      timeout: '7d',
    });
    return { status: shipped === null ? 'never-shipped' : 'shipped' };
  },
);`,
  },
  mcp: {
    label: 'Call an MCP tool',
    code: (name) => `export const ${camel(name)} = workflow(
  { name: '${name}', input: z.object({ chargeId: z.string() }) },
  async (ctx, input) => {
    // 'billing' comes from circuit.mcp.json; see docs/circuit/USAGE.md §5b
    const charge = await ctx.mcp('billing').call('get_charge', { chargeId: input.chargeId });
    return { amount: charge.amount };
  },
);`,
  },
};

export function scaffoldWorkflow(workflowsFile: string, name: string, template: string): { file: string } {
  const tpl = TEMPLATES[template];
  if (!tpl) throw new Error(`unknown template '${template}' — have: ${Object.keys(TEMPLATES).join(', ')}`);
  const file = resolve(workflowsFile);
  const banner = `\n// --- added by the Circuit dashboard (${new Date().toISOString().slice(0, 16)}Z): '${name}' (${template} template) ---\n`;
  appendFileSync(file, `${banner}${tpl.code(name)}\n`);
  return { file };
}
