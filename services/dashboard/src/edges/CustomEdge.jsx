import React from 'react';
import { BaseEdge, getBezierPath } from '@xyflow/react';

export function CustomEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data
}) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const isActive = data?.isActive;

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeWidth: isActive ? 3 : 2,
          stroke: isActive ? '#a855f7' : '#4b5563', // purple-500 or gray-600
          filter: isActive ? 'drop-shadow(0 0 5px rgba(168,85,247,0.8))' : 'none',
          transition: 'all 0.3s ease'
        }}
      />
      {isActive && (
        <circle r="4" fill="#fff" className="animate-[dash_1s_linear_infinite]">
          <animateMotion dur="1.5s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
    </>
  );
}
