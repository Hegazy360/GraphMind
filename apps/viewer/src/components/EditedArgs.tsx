/**
 * The trail an argument edit leaves (0.6.0, contract C2): in the inspector,
 * for an execution that ran with edited arguments, what the model asked for
 * (the recorded input) beside what actually ran (`exec.resumed.edited.after`),
 * key by key.
 *
 * Both sides pass through the same redaction as the node's input: under
 * GRAPHMIND_HIDE_TOOL_ARGS / HIDE_INPUTS the app writes the placeholder, and
 * the panel says the value is hidden rather than diffing two placeholders or
 * rendering the string "__REDACTED__" as if it were an argument.
 */
import { argDiff, previewValue, REDACTED, SCOPE_NOTE } from '../lib/editArgs.js';
import type { NodeExecution, NodeState } from '../store/types.js';
import { JsonTree } from './JsonTree.js';

function hiddenBy(kind: NodeState['kind']): string {
  return kind === 'tool'
    ? 'GRAPHMIND_HIDE_TOOL_ARGS or GRAPHMIND_HIDE_INPUTS'
    : 'GRAPHMIND_HIDE_INPUTS';
}

function Hidden({ kind, testId }: { kind: NodeState['kind']; testId: string }) {
  return (
    <span
      className="gm-chip gm-chip--tiny"
      data-testid={testId}
      style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: '100%' }}
      title="The instrumented app replaced this value before it left the process."
    >
      hidden by {hiddenBy(kind)}
    </span>
  );
}

/** One side of a changed key: the value, or "hidden" for the placeholder. */
function Side({ value }: { value: unknown }) {
  if (value === REDACTED) return <span className="gm-edit-hidden">hidden</span>;
  return (
    <span className="gm-mono gm-edit-value" title={previewValue(value, 2000)}>
      {previewValue(value, 120)}
    </span>
  );
}

export function EditedArgs({ node, exec }: { node: NodeState; exec: NodeExecution }) {
  const edited = exec.edited;
  if (edited === undefined) return null;
  const before = exec.input;
  const after = edited.after;
  const afterHidden = after === REDACTED;
  const beforeHidden = before === REDACTED;
  const changes = afterHidden || beforeHidden ? [] : argDiff(before, after);

  return (
    <section className="gm-inspect-section gm-edited" data-testid="edited-args" aria-label="Edited arguments">
      <div className="gm-inspect-section-head">
        <span className="gm-section-label">Edited arguments</span>
        <span className="gm-pill gm-pill--injected gm-pill--edited">edited</span>
      </div>
      <div className="gm-edit-scope">{SCOPE_NOTE}</div>

      {afterHidden ? (
        <div className="gm-edited-row">
          <span className="gm-why-label">Ran with</span>
          <Hidden kind={node.kind} testId="edited-after-hidden" />
        </div>
      ) : beforeHidden ? (
        <>
          <div className="gm-edited-row">
            <span className="gm-why-label">Asked for</span>
            <Hidden kind={node.kind} testId="edited-before-hidden" />
          </div>
          <div className="gm-why-label">Ran with</div>
          <div className="gm-why-input nowheel">
            <JsonTree value={after} initialDepth={1} rootPath="edited" searchable={false} />
          </div>
        </>
      ) : (
        <>
          {changes.length === 0 ? (
            <div className="gm-edit-empty">The edit left every recorded value as it was.</div>
          ) : (
            <table className="gm-edited-table">
              <thead>
                <tr>
                  <th scope="col">key</th>
                  <th scope="col">asked for</th>
                  <th scope="col">ran with</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={change.key} data-testid="edited-change">
                    <th scope="row">
                      <code>{change.key}</code>
                    </th>
                    <td>
                      {change.kind === 'added' ? (
                        <span className="gm-edit-hidden">not set</span>
                      ) : (
                        <Side value={change.before} />
                      )}
                    </td>
                    <td>
                      <Side value={change.after} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="gm-why-label">Ran with</div>
          <div className="gm-why-input nowheel">
            <JsonTree value={after} initialDepth={1} rootPath="edited" searchable={false} />
          </div>
        </>
      )}
    </section>
  );
}
