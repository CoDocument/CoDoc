/**
 * ActivityStream Component
 * A lightweight, clean UI at the bottom of CoDoc showing 2-3 recent events
 * with autoscroll and fading effect
 */

import React, { useEffect, useRef, useState } from 'react';

export interface ActivityItem {
  id: string;
  type: 'thinking' | 'reading' | 'editing' | 'creating' | 'diff' | 'complete' | 'error';
  message: string;
  timestamp: number;
  details?: string;
  filePath?: string;
  componentName?: string;
  additions?: number;
  deletions?: number;
}

interface ActivityStreamProps {
  activities: ActivityItem[];
  maxVisible?: number;
}

/**
 * Get icon for activity type
 */
function getActivityIcon(type: ActivityItem['type']): string {
  switch (type) {
    case 'thinking':
      return '💭';
    case 'reading':
      return '👀';
    case 'editing':
      return '✎';
    case 'creating':
      return '+';
    case 'diff':
      return '≠';
    case 'complete':
      return '✓';
    case 'error':
      return '⌫';
    default:
      return '';
  }
}

/**
 * Get color for activity type
 */
function getActivityColor(type: ActivityItem['type']): string {
  switch (type) {
    case 'thinking':
      return 'var(--vscode-foreground)';
    case 'reading':
      return 'var(--vscode-charts-blue)';
    case 'editing':
      return 'var(--vscode-charts-yellow)';
    case 'creating':
      return 'var(--vscode-charts-green)';
    case 'diff':
      return 'var(--vscode-charts-purple)';
    case 'complete':
      return 'var(--vscode-charts-green)';
    case 'error':
      return 'var(--vscode-errorForeground)';
    default:
      return 'var(--vscode-foreground)';
  }
}

/**
 * Format a concise message
 */
function formatMessage(item: ActivityItem): string {
  console.log('Formatting message for activity item:', item);
  switch (item.type) {
    case 'thinking':
      return item.message.replace('Thinking: ', '');
    case 'reading':
      return `Reading ${item.filePath?.split('/').pop() || 'file'}...`;
    case 'editing':
      const fileName = item.filePath?.split('/').pop() || 'file';
      if (item.additions !== undefined || item.deletions !== undefined) {
        return `Editing ${fileName} (+${item.additions || 0} -${item.deletions || 0})`;
      }
      return `Editing ${fileName}...`;
    case 'creating':
      return `Creating ${item.filePath?.split('/').pop() || 'file'}`;
    case 'diff':
      return item.message;
    case 'complete':
      return 'Complete';
    case 'error':
      return item.message;
    default:
      return item.message;
  }
}

export const ActivityStream: React.FC<ActivityStreamProps> = ({ 
  activities, 
  maxVisible = 3 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Auto-scroll to bottom when new activities arrive
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [activities]);

  // Only show the last N activities (or all if expanded)
  const visibleActivities = isExpanded 
    ? activities 
    : activities.slice(-maxVisible);

  if (activities.length === 0) {
    return null;
  }

  return (
    <div 
      style={{
        position: 'relative',
        borderTop: '1px solid #333333',
        backgroundColor: '#000000',
        maxHeight: isExpanded ? '200px' : '80px',
        overflow: 'hidden',
        transition: 'max-height 0.2s ease-out',
        color: '#d4d4d4'
      }}
    >
      {/* Gradient fade at top */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '20px',
          background: 'linear-gradient(to bottom, #000000, transparent)',
          pointerEvents: 'none',
          zIndex: 1,
          opacity: visibleActivities.length > 2 ? 1 : 0
        }}
      />

      {/* Activity list */}
      <div
        ref={containerRef}
        style={{
          padding: '4px 8px',
          overflowY: 'auto',
          maxHeight: isExpanded ? '180px' : '72px',
          scrollBehavior: 'smooth'
        }}
      >
        {visibleActivities.map((activity, index) => {
          // Calculate opacity based on position from bottom
          const posFromBottom = visibleActivities.length - 1 - index;
          let opacity = 1;
          if (!isExpanded) {
            if (posFromBottom === 2) opacity = 0.4;
            else if (posFromBottom === 1) opacity = 0.7;
            else if (posFromBottom === 0) opacity = 1;
            else opacity = 0;
          }

          return (
            <div
              key={activity.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '2px 0',
                fontSize: '12px',
                lineHeight: '1.4',
                opacity,
                transition: 'opacity 0.3s ease-out',
                color: getActivityColor(activity.type)
              }}
            >
              {/* Icon */}
              <span style={{ fontSize: '10px', width: '14px', flexShrink: 0 }}>
                {getActivityIcon(activity.type)}
              </span>
              
              {/* Message */}
              <span 
                style={{ 
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: '#d4d4d4'
                }}
                title={activity.message}
              >
                {formatMessage(activity)}
              </span>

              {/* Stats badge for diffs */}
              {(activity.additions !== undefined || activity.deletions !== undefined) && (
                <span
                  style={{
                    display: 'inline-flex',
                    gap: '4px',
                    fontSize: '10px',
                    opacity: 0.8
                  }}
                >
                  {activity.additions !== undefined && activity.additions > 0 && (
                    <span style={{ color: 'var(--vscode-gitDecoration-addedResourceForeground)' }}>
                      +{activity.additions}
                    </span>
                  )}
                  {activity.deletions !== undefined && activity.deletions > 0 && (
                    <span style={{ color: 'var(--vscode-gitDecoration-deletedResourceForeground)' }}>
                      -{activity.deletions}
                    </span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Expand/collapse button if there are many activities */}
      {activities.length > maxVisible && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            position: 'absolute',
            bottom: '2px',
            right: '4px',
            background: '#0e6eb8',
            border: 'none',
            color: '#ffffff',
            fontSize: '10px',
            cursor: 'pointer',
            padding: '2px 4px',
            opacity: 0.7
          }}
        >
          {isExpanded ? '▼ Less' : `▲ ${activities.length - maxVisible} more`}
        </button>
      )}
    </div>
  );
};

export default ActivityStream;
