import React from 'react';
import { Handle, Position } from '@xyflow/react';
import * as LucideIcons from 'lucide-react';

export function CustomNode({ data, selected }) {
  const isActive = data.isActive;
  
  // Dynamic Icon
  const IconComponent = LucideIcons[data.icon] || LucideIcons.Circle;

  // Determine colors based on group for a vibrant look
  let colorTheme = 'border-gray-700 shadow-lg';
  let headerColor = 'text-gray-400';
  let iconBg = 'bg-gray-800/50';
  let iconColor = 'text-gray-400';
  
  if (data.group === 'Gatilho') {
    colorTheme = isActive ? 'border-purple-500 shadow-[0_0_20px_rgba(168,85,247,0.6)]' : 'border-purple-900/50';
    headerColor = 'text-purple-300';
    iconBg = 'bg-purple-900/30';
    iconColor = 'text-purple-400';
  } else if (data.group === 'Motor Semântico') {
    colorTheme = isActive ? 'border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.6)]' : 'border-blue-900/50';
    headerColor = 'text-blue-300';
    iconBg = 'bg-blue-900/30';
    iconColor = 'text-blue-400';
  } else if (data.group === 'Roteador FSM') {
    colorTheme = isActive ? 'border-pink-500 shadow-[0_0_20px_rgba(236,72,153,0.6)]' : 'border-pink-900/50';
    headerColor = 'text-pink-300';
    iconBg = 'bg-pink-900/30';
    iconColor = 'text-pink-400';
  } else if (data.group === 'Saída') {
    colorTheme = isActive ? 'border-green-500 shadow-[0_0_20px_rgba(34,197,94,0.6)]' : 'border-green-900/50';
    headerColor = 'text-green-300';
    iconBg = 'bg-green-900/30';
    iconColor = 'text-green-400';
  } else {
    colorTheme = isActive ? 'border-indigo-400 shadow-[0_0_20px_rgba(129,140,248,0.6)]' : 'border-gray-700';
    iconColor = isActive ? 'text-indigo-400' : 'text-gray-400';
  }

  return (
    <div
      className={`min-w-[180px] relative rounded-xl bg-[#1e2330]/90 backdrop-blur-xl border-2 
        ${colorTheme}
        ${selected ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0d1117]' : ''}
        transition-all duration-300 overflow-visible`} // Make sure handles are visible
    >
      {/* Top Handle */}
      {data.handles?.top !== false && (
        <Handle type="target" position={Position.Top} className={`!bg-gray-400 !border-gray-800 !w-3 !h-3 -mt-[6px]`} />
      )}
      
      {/* Node Header */}
      <div className={`px-4 py-2 text-[10px] font-bold uppercase tracking-wider border-b border-gray-700/50 ${headerColor}`}>
        {data.group || 'Node'}
      </div>
      
      {/* Node Body */}
      <div className="p-4 flex flex-col items-center justify-center space-y-3">
        <div className={`p-3 rounded-full ${iconBg} ring-1 ring-inset ring-white/10`}>
          <IconComponent className={`w-8 h-8 ${iconColor}`} strokeWidth={1.5} />
        </div>
        <span className={`text-sm font-semibold text-center ${isActive ? 'text-white' : 'text-gray-300'}`}>
          {data.label}
        </span>
      </div>

      {/* Node Footer / Status Badge */}
      <div className="px-4 py-2 border-t border-gray-700/50 bg-gray-900/50 rounded-b-xl flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`}></div>
          <span className={`text-[10px] font-bold uppercase ${isActive ? 'text-green-400' : 'text-gray-500'}`}>
            {isActive ? 'Ativo' : data.status || 'Inativo'}
          </span>
        </div>
      </div>

      {/* Bottom Handle */}
      {data.handles?.bottom !== false && (
        <Handle type="source" position={Position.Bottom} className="!bg-gray-300 !border-gray-800 !w-3 !h-3 -mb-[6px]" />
      )}
      
      {/* Side Handles (if needed for left-to-right flows) */}
      {data.handles?.right && (
        <Handle type="source" position={Position.Right} id="right" className="!bg-gray-500" />
      )}
      {data.handles?.left && (
        <Handle type="target" position={Position.Left} id="left" className="!bg-gray-500" />
      )}
    </div>
  );
}
