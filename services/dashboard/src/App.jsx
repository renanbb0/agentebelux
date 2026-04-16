import React, { useState, useEffect, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { io } from 'socket.io-client';

import { CustomNode } from './nodes/CustomNode';
import { CustomEdge } from './edges/CustomEdge';
import { Sidebar } from './components/Sidebar';

const nodeTypes = {
  custom: CustomNode,
};

const edgeTypes = {
  custom: CustomEdge,
};

const initialNodes = [
  { id: 'webhook', type: 'custom', position: { x: 250, y: 50 }, data: { label: 'Recepção Webhook (Z-API)', group: 'Gatilho', icon: 'Webhook', status: 'Ativo' } },
  { id: 'heuristics', type: 'custom', position: { x: 250, y: 200 }, data: { label: 'Heurísticas Locais', group: 'Roteador FSM', icon: 'GitMerge', status: 'Pendente' } },
  { id: 'ai_semantic', type: 'custom', position: { x: -50, y: 350 }, data: { label: 'Processamento IA (Gemini)', group: 'Motor Semântico', icon: 'BrainCircuit', status: 'Pendente' } },
  { id: 'fsm_idle', type: 'custom', position: { x: 250, y: 350 }, data: { label: 'Aguardando (Ocioso)', group: 'Estado FSM', icon: 'Clock', status: 'Pendente' } },
  { id: 'fsm_awaiting_size', type: 'custom', position: { x: 550, y: 350 }, data: { label: 'Aguardando Tamanho', group: 'Estado FSM', icon: 'Ruler', status: 'Pendente' } },
  { id: 'fsm_awaiting_quantity', type: 'custom', position: { x: 850, y: 350 }, data: { label: 'Aguardando Quantidade', group: 'Estado FSM', icon: 'ListOrdered', status: 'Pendente' } },
  { id: 'fsm_awaiting_more_sizes', type: 'custom', position: { x: 550, y: 500 }, data: { label: 'Aguardando Mais', group: 'Estado FSM', icon: 'PackagePlus', status: 'Pendente' } },
  { id: 'cart_update', type: 'custom', position: { x: 850, y: 500 }, data: { label: 'Atualização de Carrinho', group: 'Ação do Sistema', icon: 'ShoppingCart', status: 'Pendente' } },
  { id: 'zapi_send', type: 'custom', position: { x: 250, y: 650 }, data: { label: 'Envio de Mensagem (Z-API)', group: 'Saída', icon: 'MessageCircleReply', status: 'Pendente' } },
];

const initialEdges = [
  { id: 'e1-2', source: 'webhook', target: 'heuristics', type: 'custom' },
  { id: 'e2-idle', source: 'heuristics', target: 'fsm_idle', type: 'custom' },
  { id: 'e2-size', source: 'heuristics', target: 'fsm_awaiting_size', type: 'custom' },
  { id: 'e2-qty', source: 'heuristics', target: 'fsm_awaiting_quantity', type: 'custom' },
  { id: 'e2-ai', source: 'heuristics', target: 'ai_semantic', type: 'custom' },
  { id: 'e-ai-size', source: 'ai_semantic', target: 'heuristics', type: 'custom' }, // Loop back or straight?
  { id: 'e-size-more', source: 'fsm_awaiting_size', target: 'fsm_awaiting_more_sizes', type: 'custom' },
  { id: 'e-qty-cart', source: 'fsm_awaiting_quantity', target: 'cart_update', type: 'custom' },
  { id: 'e-idle-send', source: 'fsm_idle', target: 'zapi_send', type: 'custom' },
  { id: 'e-size-send', source: 'fsm_awaiting_size', target: 'zapi_send', type: 'custom' },
  { id: 'e-qty-send', source: 'cart_update', target: 'zapi_send', type: 'custom' },
  { id: 'e-ai-send', source: 'ai_semantic', target: 'zapi_send', type: 'custom' },
];

export default function App() {
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    // Connect to Backend WebSocket
    const socket = io('http://localhost:3000'); // the port where Bela Belux node runs

    socket.on('log', (logEntry) => {
      setLogs((prev) => [logEntry, ...prev].slice(0, 50)); // Last 50 logs
      
      // Update nodes state based on events
      if (logEntry.type === 'fsm' && logEntry.state) {
        highlightNode(`fsm_${logEntry.state}`);
      }
      if (logEntry.type === 'webhook') {
        highlightNode('webhook');
        setTimeout(() => highlightNode('heuristics'), 500);
      }
      if (logEntry.type === 'ai') {
        highlightNode('ai_semantic');
      }
      if (logEntry.type === 'send') {
        highlightNode('zapi_send');
      }
    });

    return () => socket.disconnect();
  }, []);

  const highlightNode = (nodeId) => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id === nodeId) {
          return { ...n, data: { ...n.data, isActive: true } };
        }
        return { ...n, data: { ...n.data, isActive: false } }; // deactivate others for now
      })
    );
  };

  const onNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );
  const onEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  return (
    <div className="flex h-screen w-full bg-[#0d1117] text-white overflow-hidden">
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode="dark"
          fitView
          className="bg-gray-950"
        >
          <Background color="#1f2937" gap={16} />
          <Controls className="bg-gray-800 border-gray-700 fill-gray-200" />
        </ReactFlow>
      </div>
      <Sidebar logs={logs} />
    </div>
  );
}
