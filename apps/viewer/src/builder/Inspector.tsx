/**
 * The right rail's "Node" tab: the fields of whichever node is selected,
 * plus the project-level choices (name, target, provider, model) when the
 * root agent is.
 *
 * Validation messages — the local ones while typing, the server's once it
 * has answered — sit under the field they belong to. Both arrive keyed by
 * node id, so a message always lands on the card it came from.
 */
import { useState } from 'react';
import { IconClose } from '../components/Icons.js';
import { BuilderApiError, probeMcp } from './api.js';
import { useBuilderStore } from './builderStore.js';
import {
  DEFAULT_MODEL,
  NODE_BLURB,
  NODE_LABEL,
  PARAM_TYPES,
  PROVIDER_LABEL,
  ROOT_ID,
  TARGETS,
  emptyParam,
  mcpOf,
  slugify,
  targetMeta,
  withProvider,
  withTarget,
  type AgentNode,
  type McpNode,
  type SubAgentNode,
  type ToolNode,
} from './graph.js';
import { BlockedNotice, type Blocked } from './BlockedNotice.js';
import type { ProbeResult, Provider, SpecIssue, TargetId, ToolParam } from './types.js';

type Issue = SpecIssue & { nodeId?: string };

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className={`gm-bfield${error !== undefined ? ' gm-bfield--error' : ''}`}>
      <span className="gm-bfield-label">
        {label}
        {hint !== undefined && <span className="gm-bfield-hint">{hint}</span>}
      </span>
      {children}
      {error !== undefined && <span className="gm-bfield-error">{error}</span>}
    </label>
  );
}

/** The first message for this node whose path ends in `suffix`. */
function errorFor(issues: readonly Issue[], nodeId: string, suffix: string): string | undefined {
  return issues.find((issue) => issue.nodeId === nodeId && issue.path.endsWith(suffix))?.message;
}

function ParamRow({
  param,
  error,
  onChange,
  onRemove,
}: {
  param: ToolParam;
  error: string | undefined;
  onChange: (next: ToolParam) => void;
  onRemove: () => void;
}) {
  return (
    <div className={`gm-bparam${error !== undefined ? ' gm-bparam--error' : ''}`} title={error}>
      <input
        className="gm-binput gm-binput--mono"
        value={param.name}
        spellCheck={false}
        aria-label="Parameter name"
        onChange={(e) => onChange({ ...param, name: e.target.value })}
      />
      <select
        className="gm-binput"
        value={param.type}
        aria-label="Parameter type"
        onChange={(e) => onChange({ ...param, type: e.target.value as ToolParam['type'] })}
      >
        {PARAM_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
      <input
        className="gm-binput"
        value={param.description ?? ''}
        placeholder="what it means (the model reads this)"
        aria-label="Parameter description"
        onChange={(e) => onChange({ ...param, description: e.target.value })}
      />
      <label className="gm-bcheck" title="Required parameters must be sent by the model">
        <input type="checkbox" checked={param.required} onChange={(e) => onChange({ ...param, required: e.target.checked })} />
        req
      </label>
      <button className="gm-iconbtn gm-iconbtn--small" onClick={onRemove} title="Remove this parameter" aria-label="Remove parameter" type="button">
        <IconClose />
      </button>
    </div>
  );
}

function AgentFields({ node, issues }: { node: AgentNode; issues: readonly Issue[] }) {
  const graph = useBuilderStore((s) => s.graph);
  const setGraph = useBuilderStore((s) => s.setGraph);
  const patchGraph = useBuilderStore((s) => s.patchGraph);
  const update = useBuilderStore((s) => s.updateNode);
  const meta = targetMeta(graph.target);
  const nameError = issues.find((issue) => issue.path === 'name')?.message;
  const modelError = issues.find((issue) => issue.path === 'model')?.message;

  return (
    <>
      <Field label="Project name" hint="the directory and the run's app label" error={nameError}>
        <input
          className="gm-binput gm-binput--mono"
          value={graph.name}
          spellCheck={false}
          aria-label="Project name"
          onChange={(e) => patchGraph({ name: slugify(e.target.value) })}
        />
      </Field>

      <Field label="Language and framework" hint="what the generated code uses">
        <div className="gm-btargets" role="radiogroup" aria-label="Target">
          {TARGETS.map((target) => (
            <button
              key={target.id}
              type="button"
              role="radio"
              aria-checked={graph.target === target.id}
              aria-label={`${target.language === 'typescript' ? 'TypeScript' : 'Python'} · ${target.framework}`}
              className={`gm-btarget${graph.target === target.id ? ' gm-btarget--on' : ''}`}
              onClick={() => setGraph(withTarget(graph, target.id as TargetId))}
            >
              <span className="gm-btarget-lang">{target.language === 'typescript' ? 'TypeScript' : 'Python'}</span>
              <span className="gm-btarget-fw">{target.framework}</span>
            </button>
          ))}
        </div>
      </Field>

      <div className="gm-brow">
        <Field label="Provider">
          <select
            className="gm-binput"
            value={graph.provider}
            aria-label="Provider"
            onChange={(e) => setGraph(withProvider(graph, e.target.value as Provider))}
          >
            {meta.providers.map((provider) => (
              <option key={provider} value={provider}>
                {PROVIDER_LABEL[provider]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model" error={modelError}>
          <input
            className="gm-binput gm-binput--mono"
            value={graph.model}
            spellCheck={false}
            aria-label="Model"
            placeholder={DEFAULT_MODEL[graph.provider]}
            onChange={(e) => patchGraph({ model: e.target.value })}
          />
        </Field>
        <Field label="Max steps" hint="cap">
          <input
            className="gm-binput"
            type="number"
            min={1}
            max={50}
            value={node.maxSteps}
            aria-label="Max steps"
            onChange={(e) => update(node.id, { maxSteps: Math.max(1, Math.min(50, Number(e.target.value) || 1)) } as Partial<AgentNode>)}
          />
        </Field>
      </div>

      <Field label="System prompt" hint="optional">
        <textarea
          className="gm-binput"
          rows={3}
          value={node.systemPrompt}
          aria-label="System prompt"
          onChange={(e) => update(node.id, { systemPrompt: e.target.value } as Partial<AgentNode>)}
        />
      </Field>

      <Field label="Task" hint="what this run asks for" error={errorFor(issues, node.id, 'prompt')}>
        <textarea
          className="gm-binput"
          rows={3}
          value={node.prompt}
          aria-label="Task"
          onChange={(e) => update(node.id, { prompt: e.target.value } as Partial<AgentNode>)}
        />
      </Field>

      <Field label="Description" hint="for the README; optional">
        <input
          className="gm-binput"
          value={graph.description}
          aria-label="Description"
          onChange={(e) => patchGraph({ description: e.target.value })}
        />
      </Field>
    </>
  );
}

function ToolFields({ node, issues }: { node: ToolNode; issues: readonly Issue[] }) {
  const update = useBuilderStore((s) => s.updateNode);
  return (
    <>
      <Field label="Tool name" hint="what the model calls" error={errorFor(issues, node.id, '.name')}>
        <input
          className="gm-binput gm-binput--mono"
          value={node.name}
          spellCheck={false}
          aria-label="Tool name"
          onChange={(e) => update(node.id, { name: e.target.value } as Partial<ToolNode>)}
        />
      </Field>
      <Field label="Description" hint="the model reads this" error={errorFor(issues, node.id, 'description')}>
        <textarea
          className="gm-binput"
          rows={2}
          value={node.description}
          aria-label="Tool description"
          onChange={(e) => update(node.id, { description: e.target.value } as Partial<ToolNode>)}
        />
      </Field>
      <Field label="Parameters" hint="typed; they become the schema">
        <div className="gm-bparams">
          {node.params.length === 0 && <div className="gm-bempty">No parameters: the model calls this with no arguments.</div>}
          {node.params.map((param, index) => (
            <ParamRow
              key={index}
              param={param}
              error={errorFor(issues, node.id, `params.${index}.name`)}
              onChange={(next) =>
                update(node.id, { params: node.params.map((p, i) => (i === index ? next : p)) } as Partial<ToolNode>)
              }
              onRemove={() => update(node.id, { params: node.params.filter((_, i) => i !== index) } as Partial<ToolNode>)}
            />
          ))}
          <button
            className="gm-toolbtn"
            type="button"
            onClick={() => update(node.id, { params: [...node.params, emptyParam(node.params)] } as Partial<ToolNode>)}
          >
            <span className="gm-toolbtn-label">+ Add a parameter</span>
          </button>
        </div>
      </Field>
      <Field label="Stub result" hint="JSON, until you write the real one">
        <textarea
          className="gm-binput gm-binput--mono"
          rows={2}
          value={node.returns}
          spellCheck={false}
          aria-label="Stub result"
          onChange={(e) => update(node.id, { returns: e.target.value } as Partial<ToolNode>)}
        />
      </Field>
    </>
  );
}

function SubAgentFields({ node, issues }: { node: SubAgentNode; issues: readonly Issue[] }) {
  const update = useBuilderStore((s) => s.updateNode);
  const graph = useBuilderStore((s) => s.graph);
  return (
    <>
      <Field label="Sub-agent name" hint="the tool name the root agent sees" error={errorFor(issues, node.id, '.name')}>
        <input
          className="gm-binput gm-binput--mono"
          value={node.name}
          spellCheck={false}
          aria-label="Sub-agent name"
          onChange={(e) => update(node.id, { name: e.target.value } as Partial<SubAgentNode>)}
        />
      </Field>
      <Field label="When to delegate" hint="the root agent reads this" error={errorFor(issues, node.id, 'description')}>
        <textarea
          className="gm-binput"
          rows={2}
          value={node.description}
          aria-label="Sub-agent description"
          onChange={(e) => update(node.id, { description: e.target.value } as Partial<SubAgentNode>)}
        />
      </Field>
      <Field label="System prompt" hint="optional">
        <textarea
          className="gm-binput"
          rows={3}
          value={node.systemPrompt}
          aria-label="Sub-agent system prompt"
          onChange={(e) => update(node.id, { systemPrompt: e.target.value } as Partial<SubAgentNode>)}
        />
      </Field>
      <div className="gm-brow">
        <Field label="Model" hint="blank = the project's">
          <input
            className="gm-binput gm-binput--mono"
            value={node.model}
            spellCheck={false}
            aria-label="Sub-agent model"
            placeholder={graph.model}
            onChange={(e) => update(node.id, { model: e.target.value } as Partial<SubAgentNode>)}
          />
        </Field>
        <Field label="Max steps" hint="its own cap">
          <input
            className="gm-binput"
            type="number"
            min={1}
            max={20}
            value={node.maxSteps}
            aria-label="Sub-agent max steps"
            onChange={(e) =>
              update(node.id, { maxSteps: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } as Partial<SubAgentNode>)
            }
          />
        </Field>
      </div>
      <div className="gm-bnote">
        It takes one argument, <code>task</code>, and runs its own loop with whatever you wire to it. Drag from its right
        handle to a tool or an MCP server.
      </div>
    </>
  );
}

/**
 * "Test connection": the server connects to this node the way the generated
 * project will and lists its tools. The tools come back as chips; clicking
 * one adds it to (or removes it from) the allow-list, so the list can be
 * built from what the server actually publishes rather than typed from
 * memory. A bearer token for an HTTP server lives in this component's state
 * for the one request and is cleared when the answer arrives.
 */
function McpProbe({ node, canAct, blocked }: { node: McpNode; canAct: boolean; blocked: Blocked | undefined }) {
  const update = useBuilderStore((s) => s.updateNode);
  const [bearer, setBearer] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | { ok: false; message: string; ms: number } | undefined>(undefined);
  // Blocked is a state the button reports, not one it hides in: a control
  // that does nothing when clicked and explains itself only in a tooltip is
  // indistinguishable from a broken one.
  const [gate, setGate] = useState(false);
  const wantsToken = node.transport === 'http' && node.headerEnv.trim() !== '';
  const allowed = node.toolsText
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  const run = async () => {
    setResult(undefined);
    if (!canAct) {
      setGate(true);
      return;
    }
    setGate(false);
    setBusy(true);
    try {
      setResult(await probeMcp(mcpOf(node), wantsToken ? bearer : undefined));
    } catch (error) {
      const message =
        error instanceof BuilderApiError
          ? error.issues.length > 0
            ? error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
            : error.message
          : error instanceof Error
            ? error.message
            : String(error);
      setResult({ ok: false, message, ms: 0 });
    } finally {
      setBearer(''); // used once; it does not stay in memory here
      setBusy(false);
    }
  };

  const toggle = (name: string) => {
    const next = allowed.includes(name) ? allowed.filter((n) => n !== name) : [...allowed, name];
    update(node.id, { toolsText: next.join(', ') } as Partial<McpNode>);
  };

  return (
    <div className="gm-bprobe">
      <div className="gm-brun-actions">
        <button
          className="gm-action"
          style={{ flex: 'none' }}
          type="button"
          onClick={() => void run()}
          disabled={busy}
          title={
            node.transport === 'stdio'
              ? 'Spawn the command, list its tools, and stop it'
              : 'Connect to the URL, list its tools, and disconnect'
          }
        >
          {busy ? 'Connecting…' : 'Test connection'}
        </button>
        {wantsToken && (
          <input
            className="gm-binput gm-binput--mono"
            style={{ flex: 1, minWidth: 160 }}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={bearer}
            placeholder={`${node.headerEnv.trim()} for this test only`}
            aria-label="Bearer token for this test"
            onChange={(e) => setBearer(e.target.value)}
          />
        )}
      </div>
      {gate && blocked !== undefined && <BlockedNotice blocked={blocked} />}
      {result !== undefined && result.ok && (
        <div className="gm-bnotice gm-bnotice--ok" role="status">
          Connected to <strong>{result.server.name}</strong>
          {result.server.version !== '' ? ` ${result.server.version}` : ''} in {result.ms} ms · {result.tools.length}{' '}
          {result.tools.length === 1 ? 'tool' : 'tools'}
          {result.tools.length > 0 && (
            <>
              <div className="gm-bfield-hint" style={{ marginTop: 6 }}>
                Click a tool to allow only it; none selected means all of them.
              </div>
              <div className="gm-bprobe-tools">
                {result.tools.map((tool) => (
                  <button
                    key={tool.name}
                    type="button"
                    className={`gm-chip gm-chip--tiny gm-bprobe-tool${allowed.includes(tool.name) ? ' gm-chip--on' : ''}`}
                    title={tool.description}
                    onClick={() => toggle(tool.name)}
                  >
                    {tool.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {result !== undefined && !result.ok && (
        <div className="gm-bnotice gm-bnotice--error" role="status">
          Did not connect: {result.message}
          {'stderr' in result && result.stderr !== undefined && <pre className="gm-bprobe-stderr">{result.stderr}</pre>}
        </div>
      )}
    </div>
  );
}

function McpFields({
  node,
  issues,
  canAct,
  blocked,
}: {
  node: McpNode;
  issues: readonly Issue[];
  canAct: boolean;
  blocked: Blocked | undefined;
}) {
  const update = useBuilderStore((s) => s.updateNode);
  return (
    <>
      <Field label="Server name" hint="its tools arrive as name_tool" error={errorFor(issues, node.id, '.name')}>
        <input
          className="gm-binput gm-binput--mono"
          value={node.name}
          spellCheck={false}
          aria-label="MCP server name"
          onChange={(e) => update(node.id, { name: e.target.value } as Partial<McpNode>)}
        />
      </Field>
      <Field label="Transport">
        <select
          className="gm-binput"
          value={node.transport}
          aria-label="MCP transport"
          onChange={(e) => update(node.id, { transport: e.target.value as McpNode['transport'] } as Partial<McpNode>)}
        >
          <option value="stdio">stdio — a local program</option>
          <option value="http">http — a remote endpoint</option>
        </select>
      </Field>
      {node.transport === 'stdio' ? (
        <>
          <Field label="Command" hint="one program, no shell" error={errorFor(issues, node.id, 'command')}>
            <input
              className="gm-binput gm-binput--mono"
              value={node.command}
              spellCheck={false}
              aria-label="MCP command"
              placeholder="npx"
              onChange={(e) => update(node.id, { command: e.target.value } as Partial<McpNode>)}
            />
          </Field>
          <Field label="Arguments" hint="one per line" error={errorFor(issues, node.id, 'args')}>
            <textarea
              className="gm-binput gm-binput--mono"
              rows={3}
              value={node.argsText}
              spellCheck={false}
              aria-label="MCP arguments"
              onChange={(e) => update(node.id, { argsText: e.target.value } as Partial<McpNode>)}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL" hint="Streamable HTTP" error={errorFor(issues, node.id, 'url')}>
            <input
              className="gm-binput gm-binput--mono"
              value={node.url}
              spellCheck={false}
              aria-label="MCP URL"
              placeholder="https://example.com/mcp"
              onChange={(e) => update(node.id, { url: e.target.value } as Partial<McpNode>)}
            />
          </Field>
          <Field
            label="Token variable"
            hint="a NAME, never the token"
            error={errorFor(issues, node.id, 'headerEnv')}
          >
            <input
              className="gm-binput gm-binput--mono"
              value={node.headerEnv}
              spellCheck={false}
              aria-label="MCP token variable"
              placeholder="DOCS_MCP_TOKEN"
              onChange={(e) => update(node.id, { headerEnv: e.target.value.toUpperCase() } as Partial<McpNode>)}
            />
          </Field>
        </>
      )}
      <McpProbe node={node} canAct={canAct} blocked={blocked} />
      <Field label="Only these tools" hint="comma separated; blank = all of them">
        <input
          className="gm-binput gm-binput--mono"
          value={node.toolsText}
          spellCheck={false}
          aria-label="MCP tool allow-list"
          placeholder="search, fetch"
          onChange={(e) => update(node.id, { toolsText: e.target.value } as Partial<McpNode>)}
        />
      </Field>
      <div className="gm-bnote">
        The server is connected when the project starts, and every call through it is a node the debugger can hold.
        {node.transport === 'http' && node.headerEnv.trim() !== '' && (
          <>
            {' '}
            The token itself goes in the Run tab, under <code>{node.headerEnv.trim()}</code>.
          </>
        )}
      </div>
    </>
  );
}

export function Inspector({
  issues,
  canAct,
  blocked,
}: {
  issues: readonly Issue[];
  canAct: boolean;
  /** Why the page cannot act, when it cannot: the probe reports it on click. */
  blocked: Blocked | undefined;
}) {
  const graph = useBuilderStore((s) => s.graph);
  const selectedId = useBuilderStore((s) => s.selectedId);
  const select = useBuilderStore((s) => s.select);
  const deleteNode = useBuilderStore((s) => s.deleteNode);
  const node = graph.nodes.find((n) => n.id === selectedId);

  if (node === undefined) {
    return (
      <div className="gm-bform">
        <div className="gm-bempty">
          Nothing selected. Click a card to edit it, or add a node from the palette — every node is one thing you can
          test on its own.
        </div>
        <button className="gm-toolbtn" type="button" onClick={() => select(ROOT_ID)}>
          <span className="gm-toolbtn-label">Edit the agent</span>
        </button>
      </div>
    );
  }

  return (
    <div className="gm-bform">
      <div className="gm-binspector-head">
        <span className={`gm-node-kind gm-kind--${node.kind === 'subagent' ? 'agent' : node.kind}`}>
          {NODE_LABEL[node.kind]}
        </span>
        <span className="gm-bfield-hint">{NODE_BLURB[node.kind]}</span>
        {node.id !== ROOT_ID && (
          <button
            className="gm-toolbtn gm-toolbtn--danger"
            type="button"
            onClick={() => deleteNode(node.id)}
            title="Remove this node and its connections"
          >
            <span className="gm-toolbtn-label">Delete</span>
          </button>
        )}
      </div>
      {node.kind === 'agent' && <AgentFields node={node} issues={issues} />}
      {node.kind === 'tool' && <ToolFields node={node} issues={issues} />}
      {node.kind === 'subagent' && <SubAgentFields node={node} issues={issues} />}
      {node.kind === 'mcp' && <McpFields node={node} issues={issues} canAct={canAct} blocked={blocked} />}
    </div>
  );
}
