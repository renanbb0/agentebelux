import React from 'react';
import { Terminal, Activity, Zap } from 'lucide-react';

export function Sidebar({ logs }) {
  return (
    <div className="w-80 h-full bg-gray-900 border-l border-gray-800 flex flex-col">
      <div className="p-4 border-b border-gray-800 flex items-center gap-2">
        <Activity className="w-5 h-5 text-purple-400" />
        <h2 className="text-sm font-semibold text-gray-200 uppercase tracking-wider">Live Activity</h2>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {logs.length === 0 ? (
          <div className="text-center text-gray-500 text-xs mt-10">
            Aguardando eventos do sistema...
          </div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="text-xs bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-gray-400 font-mono">{new Date(log.timestamp).toLocaleTimeString()}</span>
                {log.type === 'fsm' && <span className="bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded text-[10px] uppercase font-bold">FSM</span>}
                {log.type === 'ai' && <span className="bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded text-[10px] uppercase font-bold">AI</span>}
                {log.type === 'webhook' && <span className="bg-green-500/20 text-green-400 px-2 py-0.5 rounded text-[10px] uppercase font-bold">Webhook</span>}
              </div>
              <div className="text-gray-300 font-mono break-words whitespace-pre-wrap">
                {typeof log.message === 'object' ? JSON.stringify(log.message, null, 2) : log.message}
              </div>
            </div>
          ))
        )}
      </div>
      
      <div className="p-4 border-t border-gray-800 bg-gray-900/80 backdrop-blur-sm">
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Zap className="w-4 h-4 text-green-400 animate-pulse" />
          Conectado ao Backend
        </div>
      </div>
    </div>
  );
}
