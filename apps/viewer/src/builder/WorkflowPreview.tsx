/**
 * The shape the run will have on the canvas, drawn from the spec before
 * anything runs: agent -> llm step -> tools. The same kind glyphs and tints
 * as the real cards, so the preview and the live graph read the same.
 */
import { KindGlyph } from '../components/KindMark.js';
import { PREVIEW_CARD, previewGraph } from './model.js';
import type { WorkflowSpec } from './types.js';

export function WorkflowPreview({ spec }: { spec: WorkflowSpec }) {
  const graph = previewGraph(spec);
  return (
    <div className="gm-bpreview" aria-label="Workflow preview">
      <div className="gm-bpreview-stage" style={{ width: graph.width, height: graph.height }}>
        <svg className="gm-bpreview-edges" width={graph.width} height={graph.height} aria-hidden="true">
          {graph.edges.map((edge) => (
            <path key={`${edge.from}->${edge.to}`} d={edge.d} />
          ))}
        </svg>
        {graph.nodes.map((node) => (
          <div
            key={node.id}
            className={`gm-bpreview-card gm-kind--${node.kind}`}
            style={{ left: node.x, top: node.y, width: PREVIEW_CARD.width, height: PREVIEW_CARD.height }}
            data-kind={node.kind}
          >
            <span className="gm-bpreview-kind">
              <KindGlyph kind={node.kind} size={10} />
              {node.kind}
            </span>
            <span className="gm-bpreview-title" title={node.title}>
              {node.title}
            </span>
            <span className="gm-bpreview-sub" title={node.subtitle}>
              {node.subtitle}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
