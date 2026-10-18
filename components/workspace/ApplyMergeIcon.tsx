'use client'

import React from 'react'

export interface ApplyMergeIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string
  className?: string
  strokeWidth?: number | string
}

/**
 * ApplyMergeIcon — Developer tool icon representing "Apply" / "Auto-Remediation".
 * Precision wrench graphic with ergonomic inner handle detail line.
 */
export const ApplyMergeIcon = React.forwardRef<SVGSVGElement, ApplyMergeIconProps>(
  (
    {
      size = 18,
      className = '',
      strokeWidth = 1.25,
      ...props
    },
    ref
  ) => {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
        {...props}
      >
        {/* Main Wrench Body (Jaw and Handle) */}
        <path d="M16 4.5a4.5 4.5 0 0 0-4.9 7.3L6.5 16.4a2.1 2.1 0 0 0 3 3l4.6-4.6a4.5 4.5 0 0 0 7.3-4.9l-3 3-3-3 3-3z" />
        {/* Inner handle line detail */}
        <line x1="8" y1="17" x2="11.5" y2="13.5" />
      </svg>
    )
  }
)

ApplyMergeIcon.displayName = 'ApplyMergeIcon'
export const ApplyToolIcon = ApplyMergeIcon
