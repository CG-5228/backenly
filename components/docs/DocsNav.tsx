import Link from 'next/link'
import { ChevronDown, LayoutGrid } from 'lucide-react'
import type { ReactNode } from 'react'
import { DOC_GROUPS, DOCS_BY_SLUG, docsInGroup, type DocSlug } from '@/app/docs/content'
import { DOC_ICONS } from './DocIcon'

/** The small tag the console sidebar puts beside a label, such as MCP or Beta. */
export function DocTag({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`shrink-0 rounded-[6px] border border-white/[0.10] px-1.5 py-px text-[11px] font-medium tracking-normal text-zinc-400 ${className}`}
    >
      {children}
    </span>
  )
}

/**
 * Every docs page, grouped exactly like the console sidebar, with the same
 * icons. Shared by the desktop rail and the phone menu so the two can never
 * list different pages.
 */
function DocsNavList({ current }: { current?: DocSlug }) {
  const item = (active: boolean) =>
    `group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[14px] tracking-[-0.006em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 ${
      active ? 'bg-white/[0.07] text-white' : 'text-zinc-400 hover:bg-white/[0.035] hover:text-zinc-100'
    }`
  const icon = (active: boolean) =>
    `h-4 w-4 shrink-0 transition-colors duration-200 ${active ? 'text-violet-300' : 'text-zinc-500 group-hover:text-zinc-300'}`

  return (
    <div className="flex flex-col gap-6">
      <Link href="/docs" aria-current={current ? undefined : 'page'} className={item(!current)}>
        <LayoutGrid aria-hidden strokeWidth={1.75} className={icon(!current)} />
        <span>Overview</span>
      </Link>

      {DOC_GROUPS.map((group) => (
        <div key={group.id}>
          <p className="mb-1.5 px-2.5 text-[12.5px] font-medium text-zinc-500">{group.label}</p>
          <ul className="flex flex-col gap-0.5">
            {docsInGroup(group.id).map((doc) => {
              const Icon = DOC_ICONS[doc.slug]
              const active = doc.slug === current
              return (
                <li key={doc.slug}>
                  <Link href={`/docs/${doc.slug}`} aria-current={active ? 'page' : undefined} className={item(active)}>
                    <Icon aria-hidden strokeWidth={1.75} className={icon(active)} />
                    <span className="min-w-0 truncate">{doc.title}</span>
                    {doc.tag && <DocTag className="ml-auto">{doc.tag}</DocTag>}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

/** The desktop rail, from lg up. */
export function DocsSidebar({ current }: { current?: DocSlug }) {
  return (
    <nav aria-label="Documentation" className="sticky top-[100px]">
      <DocsNavList current={current} />
    </nav>
  )
}

/**
 * Below lg, the same list behind a disclosure at the top of the page, so a
 * phone reader can reach any section without scrolling to the foot of a long
 * page. A native <details>: it works without JavaScript, is keyboard operable
 * and is announced as expandable. Keyed by the page, so it is closed again
 * after a navigation instead of carrying its open state across.
 */
export function DocsMobileNav({ current }: { current?: DocSlug }) {
  const doc = current ? DOCS_BY_SLUG[current] : undefined
  const Icon = doc ? DOC_ICONS[doc.slug] : LayoutGrid

  return (
    <details key={current ?? 'overview'} className="group rounded-lg border border-white/[0.10] bg-white/[0.02] lg:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-[14px] text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon aria-hidden strokeWidth={1.75} className="h-4 w-4 shrink-0 text-violet-300" />
          <span className="truncate">{doc ? doc.title : 'Overview'}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-zinc-500">
          All sections
          <ChevronDown aria-hidden className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
        </span>
      </summary>
      <nav aria-label="Documentation" className="border-t border-white/[0.08] px-2 pb-3 pt-4">
        <DocsNavList current={current} />
      </nav>
    </details>
  )
}
