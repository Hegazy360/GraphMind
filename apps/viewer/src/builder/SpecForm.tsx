/**
 * The left column of the Build page: describe the agent. Plain controlled
 * inputs over the spec in the builder store; validation messages (local
 * ones while typing, the server's once it has answered) sit under the
 * field they belong to, keyed by the same dotted path the server uses.
 */
import { useBuilderStore } from './builderStore.js';
import {
  DEFAULT_MODEL,
  PARAM_TYPES,
  PROVIDER_LABEL,
  TARGETS,
  emptyParam,
  emptyTool,
  issueFor,
  slugify,
  targetMeta,
  withProvider,
  withTarget,
} from './model.js';
import type { Provider, SpecIssue, TargetId, ToolParam, ToolSpec } from './types.js';
import { IconClose } from '../components/Icons.js';

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

function ParamRow({
  param,
  path,
  issues,
  onChange,
  onRemove,
}: {
  param: ToolParam;
  path: string;
  issues: readonly SpecIssue[];
  onChange: (next: ToolParam) => void;
  onRemove: () => void;
}) {
  const nameError = issueFor(issues, `${path}.name`);
  return (
    <div className={`gm-bparam${nameError !== undefined ? ' gm-bparam--error' : ''}`} title={nameError}>
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

function ToolCard({
  tool,
  index,
  issues,
  onChange,
  onRemove,
}: {
  tool: ToolSpec;
  index: number;
  issues: readonly SpecIssue[];
  onChange: (next: ToolSpec) => void;
  onRemove: () => void;
}) {
  const path = `tools.${index}`;
  return (
    <div className="gm-btool">
      <div className="gm-btool-head">
        <span className="gm-node-kind gm-kind--tool">tool</span>
        <input
          className={`gm-binput gm-binput--mono gm-btool-name${issueFor(issues, `${path}.name`) !== undefined ? ' gm-binput--error' : ''}`}
          value={tool.name}
          spellCheck={false}
          aria-label="Tool name"
          title={issueFor(issues, `${path}.name`) ?? 'The function name, as the model will call it'}
          onChange={(e) => onChange({ ...tool, name: e.target.value })}
        />
        <button className="gm-iconbtn gm-iconbtn--small" onClick={onRemove} title="Remove this tool" aria-label={`Remove tool ${tool.name}`} type="button">
          <IconClose />
        </button>
      </div>
      <Field label="Description" hint="what the model reads" error={issueFor(issues, `${path}.description`)}>
        <input
          className="gm-binput"
          value={tool.description}
          placeholder="Search round-trip flights between two cities for a month."
          onChange={(e) => onChange({ ...tool, description: e.target.value })}
        />
      </Field>
      <div className="gm-bfield-label">
        Parameters
        <button
          className="gm-copy"
          type="button"
          onClick={() => onChange({ ...tool, params: [...tool.params, emptyParam(tool.params)] })}
          disabled={tool.params.length >= 12}
        >
          + add
        </button>
      </div>
      {tool.params.length === 0 ? (
        <div className="gm-bempty">No parameters: the model calls it with nothing.</div>
      ) : (
        <div className="gm-bparams">
          {tool.params.map((param, pi) => (
            <ParamRow
              key={pi}
              param={param}
              path={`${path}.params.${pi}`}
              issues={issues}
              onChange={(next) => onChange({ ...tool, params: tool.params.map((p, i) => (i === pi ? next : p)) })}
              onRemove={() => onChange({ ...tool, params: tool.params.filter((_, i) => i !== pi) })}
            />
          ))}
        </div>
      )}
      <Field label="Stub result" hint="JSON becomes a literal; anything else a string. You replace it in code.">
        <textarea
          className="gm-binput gm-binput--mono"
          rows={2}
          value={tool.returns}
          spellCheck={false}
          onChange={(e) => onChange({ ...tool, returns: e.target.value })}
        />
      </Field>
    </div>
  );
}

export function SpecForm({ issues }: { issues: readonly SpecIssue[] }) {
  const spec = useBuilderStore((s) => s.spec);
  const patch = useBuilderStore((s) => s.patchSpec);
  const setSpec = useBuilderStore((s) => s.setSpec);
  const target = targetMeta(spec.target);

  return (
    <div className="gm-bform">
      <div className="gm-section-label">Agent</div>
      <Field label="Name" hint="directory and app label" error={issueFor(issues, 'name')}>
        <input
          className="gm-binput gm-binput--mono"
          value={spec.name}
          spellCheck={false}
          onChange={(e) => patch({ name: slugify(e.target.value) || e.target.value.toLowerCase() })}
        />
      </Field>
      <Field label="What it does" hint="optional, goes in the README">
        <input className="gm-binput" value={spec.description ?? ''} onChange={(e) => patch({ description: e.target.value })} />
      </Field>

      <div className="gm-section-label" style={{ marginTop: 14 }}>
        Language & framework
      </div>
      <div className="gm-btargets" role="radiogroup" aria-label="Target">
        {TARGETS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={spec.target === t.id}
            className={`gm-btarget${spec.target === t.id ? ' gm-btarget--on' : ''}`}
            onClick={() => setSpec(withTarget(spec, t.id as TargetId))}
            title={`${t.adapter} — ${t.docs}`}
          >
            <span className="gm-btarget-lang">{t.language === 'typescript' ? 'TypeScript' : 'Python'}</span>
            <span className="gm-btarget-fw">{t.framework}</span>
          </button>
        ))}
      </div>

      <div className="gm-section-label" style={{ marginTop: 14 }}>
        Model
      </div>
      <div className="gm-brow">
        <Field label="Provider" error={issueFor(issues, 'provider')}>
          <select
            className="gm-binput"
            value={spec.provider}
            onChange={(e) => setSpec(withProvider(spec, e.target.value as Provider))}
          >
            {(['anthropic', 'openai'] as Provider[]).map((p) => (
              <option key={p} value={p} disabled={!target.providers.includes(p)}>
                {PROVIDER_LABEL[p]}
                {target.providers.includes(p) ? '' : ` (not with ${target.framework})`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model id" hint={`default ${DEFAULT_MODEL[spec.provider]}`} error={issueFor(issues, 'model')}>
          <input className="gm-binput gm-binput--mono" value={spec.model} spellCheck={false} onChange={(e) => patch({ model: e.target.value })} />
        </Field>
        <Field label="Max steps" hint="model turns" error={issueFor(issues, 'maxSteps')}>
          <input
            className="gm-binput gm-binput--mono"
            type="number"
            min={1}
            max={50}
            value={spec.maxSteps}
            onChange={(e) => patch({ maxSteps: Math.max(1, Math.min(50, Math.round(Number(e.target.value) || 1))) })}
          />
        </Field>
      </div>

      <div className="gm-section-label" style={{ marginTop: 14 }}>
        Prompts
      </div>
      <Field label="System prompt" hint="optional">
        <textarea className="gm-binput" rows={3} value={spec.systemPrompt ?? ''} onChange={(e) => patch({ systemPrompt: e.target.value })} />
      </Field>
      <Field label="Task" hint="the user message the agent starts from" error={issueFor(issues, 'prompt')}>
        <textarea className="gm-binput" rows={3} value={spec.prompt} onChange={(e) => patch({ prompt: e.target.value })} />
      </Field>

      <div className="gm-section-label gm-btools-head" style={{ marginTop: 14 }}>
        Tools <span className="gm-badge-count">{spec.tools.length}</span>
        <button
          className="gm-action"
          type="button"
          style={{ flex: 'none', marginLeft: 'auto' }}
          disabled={spec.tools.length >= 20}
          onClick={() => patch({ tools: [...spec.tools, emptyTool(spec.tools)] })}
        >
          + Add a tool
        </button>
      </div>
      {spec.tools.length === 0 && (
        <div className="gm-bempty">
          No tools: the model answers in one step. Add one to get a tool call the debugger can hold, edit and inject.
        </div>
      )}
      {spec.tools.map((tool, index) => (
        <ToolCard
          key={index}
          tool={tool}
          index={index}
          issues={issues}
          onChange={(next) => patch({ tools: spec.tools.map((t, i) => (i === index ? next : t)) })}
          onRemove={() => patch({ tools: spec.tools.filter((_, i) => i !== index) })}
        />
      ))}
    </div>
  );
}
