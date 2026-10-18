import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'
import { withCode } from '@/components/site/kit'
import { PROSE_LINK } from '@/components/site/tokens'

const LINK = /(\[[^\]]+\]\([^)\s]+\))/g
const LINK_PARTS = /^\[([^\]]+)\]\(([^)\s]+)\)$/

/**
 * Renders a docs content string: `code` as inline code and [label](/path) as a
 * link. Only these two, on purpose: the content is data, and anything richer
 * belongs in a dedicated field (steps, code) rather than in a markup dialect.
 */
export function rich(text: string): ReactNode {
  if (!text.includes('](')) return withCode(text)

  return text.split(LINK).map((part, index) => {
    const match = LINK_PARTS.exec(part)
    if (!match) return <Fragment key={index}>{withCode(part)}</Fragment>

    const [, label, href] = match
    if (href.startsWith('/') && !/\.(md|txt|xml)$/.test(href)) {
      return (
        <Link key={index} href={href} className={PROSE_LINK}>
          {withCode(label)}
        </Link>
      )
    }
    const external = href.startsWith('http')
    return (
      <a
        key={index}
        href={href}
        className={PROSE_LINK}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
      >
        {withCode(label)}
      </a>
    )
  })
}
