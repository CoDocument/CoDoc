/**
 * ActivityStream Component
 * A lightweight, clean UI at the bottom of CoDoc showing 2-3 recent events
 * with autoscroll and fading effect
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';

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
  isGenerating?: boolean;
}

/**
 * Get SVG icon for activity type
 */
function getActivityIcon(type: ActivityItem['type']): JSX.Element {
  const svgStyle = { width: '12px', height: '12px', display: 'inline-block' };

  switch (type) {
    case 'thinking':
      return (
        <svg style={svgStyle} viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="6" r="1.5" />
          <circle cx="12" cy="18" r="1.5" />
        </svg>
      );
    case 'reading':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
        </svg>
      );
    case 'editing':
      return (
        <svg style={svgStyle} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 5L15 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 8H15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 11H11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M18.4563 13.5423L13.9268 18.0719C13.6476 18.3511 13.292 18.5414 12.9048 18.6188L10.8153 19.0367L11.2332 16.9472C11.3106 16.5601 11.5009 16.2045 11.7801 15.9253L16.3096 11.3957M18.4563 13.5423L19.585 12.4135C19.9755 12.023 19.9755 11.3898 19.585 10.9993L18.8526 10.2669C18.4621 9.8764 17.8289 9.8764 17.4384 10.2669L16.3096 11.3957M18.4563 13.5423L16.3096 11.3957" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'creating':
      return (
        <svg style={svgStyle} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M13 3H7C5.89543 3 5 3.89543 5 5V19C5 20.1046 5.89543 21 7 21H17C18.1046 21 19 20.1046 19 19V9M13 3L19 9M13 3V8C13 8.55228 13.4477 9 14 9H19M12 13V17M14 15H10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'diff':
      return (
        <svg style={svgStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 6h6M9 12h6M9 18h6" />
        </svg>
      );
    case 'complete':
      return (
        <svg style={svgStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      );
    case 'error':
      return (
        <svg style={svgStyle} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return <span style={svgStyle}>•</span>;
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
  maxVisible = 3,
  isGenerating = false
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [height, setHeight] = useState(80); // Default height
  const [isResizing, setIsResizing] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // Deduplicate and merge streaming activities
  const deduplicatedActivities = React.useMemo(() => {
    const result: ActivityItem[] = [];
    const seenMessages = new Map<string, number>();

    for (let i = 0; i < activities.length; i++) {
      const activity = activities[i];
      const key = `${activity.type}-${activity.filePath || ''}-${activity.componentName || ''}`;

      // For thinking/streaming messages, check if this is an extension of previous message
      if (activity.type === 'thinking') {
        const lastIndex = result.length - 1;
        if (lastIndex >= 0 && result[lastIndex].type === 'thinking') {
          const lastMsg = result[lastIndex].message;
          // If current message starts with or extends the previous one, update it
          if (activity.message.startsWith(lastMsg) || lastMsg.startsWith(activity.message)) {
            result[lastIndex] = {
              ...result[lastIndex],
              message: activity.message.length > lastMsg.length ? activity.message : lastMsg,
              timestamp: activity.timestamp
            };
            continue;
          }
        }
      }

      // For other types, deduplicate by key within a time window (500ms)
      const lastSeen = seenMessages.get(key);
      if (lastSeen !== undefined && activity.timestamp - activities[lastSeen].timestamp < 500) {
        // Update existing entry with latest data
        result[result.length - 1 - (i - lastSeen - 1)] = {
          ...result[result.length - 1 - (i - lastSeen - 1)],
          ...activity
        };
      } else {
        result.push(activity);
        seenMessages.set(key, i);
      }
    }

    return result;
  }, [activities]);

  // Auto-scroll to bottom when new activities arrive
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [deduplicatedActivities]);

  // Handle mouse down to start resizing
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startYRef.current = e.clientY;
    startHeightRef.current = height;
  }, [height]);

  // Handle mouse move during resize
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = startYRef.current - e.clientY;
      const newHeight = Math.max(60, Math.min(400, startHeightRef.current + deltaY));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Only show the last N activities (or all if expanded)
  const visibleActivities = isExpanded
    ? deduplicatedActivities
    : deduplicatedActivities.slice(-maxVisible);

  const showPlaceholder = deduplicatedActivities.length === 0;
  const shouldRender = showPlaceholder ? isGenerating : deduplicatedActivities.length > 0;

  if (!shouldRender) {
    return null;
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        borderTop: '1px solid #333333',
        backgroundColor: '#000000',
        height: `${height}px`,
        overflow: 'hidden',
        transition: isResizing ? 'none' : 'height 0.2s ease-out',
        color: '#d4d4d4',
        zIndex: 100
      }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '4px',
          cursor: 'ns-resize',
          backgroundColor: 'transparent',
          transition: 'background-color 0.2s',
          zIndex: 2
        }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#0e6eb8'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      />

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
          opacity: !showPlaceholder && visibleActivities.length > 2 ? 1 : 0
        }}
      />

      {/* Activity list */}
      <div
        ref={containerRef}
        style={{
          padding: '8px 8px 4px 8px',
          overflowY: 'auto',
          height: '100%',
          scrollBehavior: 'smooth'
        }}
      >
        {showPlaceholder ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              height: '100%',
              fontSize: '12px',
              color: '#d4d4d4',
              gap: '12px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0e6eb8" strokeWidth="2">
                <circle cx="12" cy="12" r="10" opacity="0.3" />
                <path d="M12 2 a10 10 0 0 1 10 10" strokeLinecap="round">
                  <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from="0 12 12"
                    to="360 12 12"
                    dur="1.2s"
                    repeatCount="indefinite"
                  />
                </path>
              </svg>
              <span>Waiting for agent activity...</span>
            </div>
            <span style={{ fontSize: '11px', opacity: 0.7 }}>
              Updates will stream here as Claude or OpenCode works.
            </span>
          </div>
        ) : (
          visibleActivities.map((activity, index) => {
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
                  alignItems: 'flex-start',
                  gap: '8px',
                  padding: '3px 0',
                  fontSize: '12px',
                  lineHeight: '1.4',
                  opacity,
                  transition: 'opacity 0.3s ease-out',
                  color: getActivityColor(activity.type)
                }}
              >
                {/* Icon */}
                <span style={{ width: '14px', flexShrink: 0, paddingTop: '2px' }}>
                  {getActivityIcon(activity.type)}
                </span>

                {/* Message - allow wrapping for long messages */}
                <span
                  style={{
                    flex: 1,
                    color: '#d4d4d4',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word'
                  }}
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
                      opacity: 0.8,
                      flexShrink: 0
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
          })
        )}
      </div>

      {/* Expand/collapse button if there are many activities */}
      {!showPlaceholder && deduplicatedActivities.length > maxVisible && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            position: 'absolute',
            bottom: '4px',
            right: '8px',
            background: '#0e6eb8',
            border: 'none',
            color: '#ffffff',
            fontSize: '10px',
            cursor: 'pointer',
            padding: '3px 6px',
            borderRadius: '3px',
            opacity: 0.8,
            transition: 'opacity 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
          onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}
        >
          {isExpanded ? '▼ Less' : `▲ ${deduplicatedActivities.length - maxVisible} more`}
        </button>
      )}
    </div>
  );
};

export default ActivityStream;
