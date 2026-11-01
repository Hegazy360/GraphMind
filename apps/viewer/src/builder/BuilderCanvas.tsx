/**
 * The canvas: the workflow as nodes you can place, wire and drag.
 *
 * It is the same React Flow the debugger draws runs with, so a graph you
 * build here and the run it produces look like the same object — one card
 * per code location, edges the way calls go.
 *
 * Dragging from a handle wires one node to another; only the edges that
 * mean something are allowed (graph.ts `canConnect`), so there is no way to
 * draw a graph the generator cannot emit.
 */
import { useCallback, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import { useBuilderStore } from './builderStore.js';
import { NODE_LABEL, ROOT_ID, canConnect, type GraphNode, type NodeKind, type WorkflowGraph } from './graph.js';

interface CardData extends Record<string, unknown> {
  node: GraphNode;
  title: string;
  subtitle: string;
  problems: string[];
}

/** One card. Kind drives the colour, the same way the debugger's cards do. */
function Card({ data, selected }: NodeProps<Node<CardData>>) {
  const { node, title, subtitle, problems } = data;
  const kind = node.kind;
  return (
    <div
      className={`gm-bnode gm-bnode--${kind}${selected === true ? ' gm-bnode--on' : ''}${problems.length > 0 ? ' gm-bnode--bad' : ''}`}
      data-kind={kind}
      data-name={kind === 'agent' ? 'agent' : node.name}
      title={problems.join('\n')}
    >
      {kind !== 'agent' && <Handle type="target" position={Position.Left} className="gm-bhandle" />}
      <div className="gm-bnode-kind">
        {NODE_LABEL[kind]}
        {problems.length > 0 && (
          <span className="gm-bnode-warn" aria-label={`${problems.length} problem(s)`}>
            !
          </span>
        )}
      </div>
      <div className="gm-bnode-title">{title}</div>
      <div className="gm-bnode-sub">{subtitle}</div>
      {(kind === 'agent' || kind === 'subagent') && (
        <Handle type="source" position={Position.Right} className="gm-bhandle" />
      )}
    </div>
  );
}

const NODE_TYPES: NodeTypes = { card: Card };

const CARD_WIDTH = 220;

function titleOf(node: GraphNode, graph: WorkflowGraph): string {
  return node.kind === 'agent' ? graph.name || 'agent' : node.name || NODE_LABEL[node.kind];
}

function subtitleOf(node: GraphNode, graph: WorkflowGraph): string {
  switch (node.kind) {
    case 'agent':
      return `${graph.model || graph.provider} · ${node.maxSteps} steps`;
    case 'subagent':
      return `${node.model.trim() === '' ? graph.model : node.model} · ${node.maxSteps} steps`;
    case 'tool':
      return node.params.length === 0 ? 'no parameters' : node.params.map((p) => p.name).join(', ');
    case 'mcp':
      return node.transport === 'stdio'
        ? `stdio · ${[node.command, ...node.argsText.split('\n').map((a) => a.trim()).filter(Boolean)].join(' ').slice(0, 48)}`
        : `http · ${node.url}`;
  }
}

export function BuilderCanvas({ problems }: { problems: Record<string, string[]> }) {
  const graph = useBuilderStore((s) => s.graph);
  const selectedId = useBuilderStore((s) => s.selectedId);
  const select = useBuilderStore((s) => s.select);
  const moveNode = useBuilderStore((s) => s.moveNode);
  const deleteNode = useBuilderStore((s) => s.deleteNode);
  const connect = useBuilderStore((s) => s.connect);
  const disconnect = useBuilderStore((s) => s.disconnect);

  const nodes = useMemo<Node<CardData>[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'card',
        position: { x: node.x, y: node.y },
        selected: node.id === selectedId,
        deletable: node.id !== ROOT_ID,
        width: CARD_WIDTH,
        data: {
          node,
          title: titleOf(node, graph),
          subtitle: subtitleOf(node, graph),
          problems: problems[node.id] ?? [],
        },
      })),
    [graph, selectedId, problems],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        className: 'gm-bedge',
      })),
    [graph.edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CardData>>[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position !== undefined) {
          moveNode(change.id, change.position);
        } else if (change.type === 'remove') {
          deleteNode(change.id);
        } else if (change.type === 'select' && change.selected) {
          select(change.id);
        }
      }
    },
    [moveNode, deleteNode, select],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      for (const change of changes) if (change.type === 'remove') disconnect(change.id);
    },
    [disconnect],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source === null || connection.target === null) return;
      connect(connection.source, connection.target);
    },
    [connect],
  );

  // Refuse a connection the generator could not emit, while it is being
  // dragged: the handle simply will not take.
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const source = graph.nodes.find((node) => node.id === connection.source);
      const target = graph.nodes.find((node) => node.id === connection.target);
      if (source === undefined || target === undefined) return false;
      return canConnect(source.kind as NodeKind, target.kind as NodeKind);
    },
    [graph.nodes],
  );

  return (
    <div className="gm-bcanvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onPaneClick={() => select(undefined)}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
      </ReactFlow>
    </div>
  );
}
