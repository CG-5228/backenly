import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { ButtonLink, HorizonClose, JsonLd, Page, PageHero, Section } from '@/components/site/kit'
import { Reveal } from '@/components/site/Reveal'
import { StartButton } from '@/components/site/StartButton'
import { HEADING, TITLE } from '@/components/site/tokens'
import { DOC_ICONS } from '@/components/docs/DocIcon'
import { DocTag } from '@/components/docs/DocsNav'
import { DOC_GROUPS, DOC_SECTIONS, docsInGroup } from './content'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Documentation: Backenly',
  description:
    'What each section of the Backenly console does, when you need it, and how it works: Database, Auth & Users, Storage, Functions, Realtime, Integrations, Autonomy, Monitoring, Branches, Deploy, Connect, Webhooks and Settings.',
  keywords: [
    'Backenly documentation',
    'Backenly docs',
    'MCP backend',
    'backend file storage',
    'server-side functions',
    'row-level security postgres',
  ],
  openGraph: {
    title: 'Backenly Documentation',
    description: 'Every section of the Backenly console: what it does, when you need it, and how it works.',
    url: `${APP_URL}/docs`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Documentation',
    description: 'Every section of the Backenly console, explained.',
  },
  alternates: { canonical: `${APP_URL}/docs` },
}

const collectionSchema = {
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: 'Backenly Documentation',
  description: 'One page per section of the Backenly console: what it does, when you need it, and how it works.',
  url: `${APP_URL}/docs`,
  publisher: { '@type': 'Organization', name: 'Backenly', url: APP_URL },
  hasPart: DOC_SECTIONS.map((d) => ({
    '@type': 'TechArticle',
    headline: d.title,
    url: `${APP_URL}/docs/${d.slug}`,
    description: d.purpose,
  })),
}

/* ─────────────────────────────────────────────────────────────
   /docs: the documentation home.

   One row per section of the project console, grouped and ordered exactly like
   the console sidebar and carrying the same icons, so a reader looking at the
   console can find the page for what is in front of them. Each row says what
   the section is for in one line; the page behind it explains why you would
   need it and how it works.
───────────────────────────────────────────────────────────── */

export default function DocsPage() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(collectionSchema)} />
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Documentation' }]}
          title="Documentation"
          lede="Every section of the Backenly console, one page each: what it does, when you need it, and how it works. New here? Start with Connect, then Database."
          actions={
            <ButtonLink href="/docs/connect">
              Start with Connect
              <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </ButtonLink>
          }
        />

        <Section flush aria-label="Console sections">
          {DOC_GROUPS.map((group, groupIndex) => (
            <div
              key={group.id}
              className={`grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16 ${
                groupIndex === 0 ? '' : 'mt-20 md:mt-28'
              }`}
            >
              <Reveal className="lg:sticky lg:top-28 lg:self-start">
                <h2 className={`text-[26px] text-white md:text-[34px] ${TITLE}`}>{group.label}</h2>
                <p className="mt-3 max-w-[40ch] text-[16px] leading-[1.65] text-zinc-400">{group.blurb}</p>
              </Reveal>
              <Reveal delay={0.06}>
                <ul>
                  {docsInGroup(group.id).map((doc, index) => {
                    const Icon = DOC_ICONS[doc.slug]
                    return (
                      <li key={doc.slug}>
                        <Link
                          href={`/docs/${doc.slug}`}
                          className={`group grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-5 py-6 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 ${
                            index === 0 ? 'border-t border-white/[0.10]' : 'border-t border-white/[0.07]'
                          }`}
                        >
                          <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.10] bg-white/[0.03] text-zinc-400 transition-colors duration-200 group-hover:border-violet-300/40 group-hover:text-white">
                            <Icon aria-hidden strokeWidth={1.75} className="h-[18px] w-[18px]" />
                          </span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                              <span className={`text-[19px] text-white md:text-[21px] ${HEADING}`}>{doc.title}</span>
                              {doc.tag && <DocTag>{doc.tag}</DocTag>}
                            </span>
                            <span className="mt-1.5 block max-w-[62ch] text-[15px] leading-[1.65] text-zinc-400 [text-wrap:pretty]">
                              {doc.purpose}
                            </span>
                          </span>
                          <ArrowRight
                            aria-hidden
                            className="mt-3 hidden h-4 w-4 text-zinc-600 transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:text-white sm:block"
                          />
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </Reveal>
            </div>
          ))}
        </Section>

        <HorizonClose
          title="Read it, then try it"
          lede="One free project, no card. Connect your agent and see every section on a live backend."
        >
          <StartButton />
          <ButtonLink href="/contact" variant="secondary">
            Ask a question
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
