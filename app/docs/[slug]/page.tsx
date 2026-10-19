import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import { JsonLd, Page, Steps, Trail } from '@/components/site/kit'
import { ScrollSpy } from '@/components/site/ScrollSpy'
import { CONTAINER, DISPLAY, HEADING, PANEL, TITLE } from '@/components/site/tokens'
import { DOC_ICONS } from '@/components/docs/DocIcon'
import { DocsMobileNav, DocsSidebar, DocTag } from '@/components/docs/DocsNav'
import { DocVideo } from '@/components/docs/DocVideo'
import { rich } from '@/components/docs/rich'
import { consolePath, DOC_HEADINGS, DOC_SECTIONS, DOCS_BY_SLUG, DOCS_UPDATED, type DocSection } from '../content'
import { DOC_VIDEOS } from '../videos'

const APP_URL = 'https://backenly.com'

function findDoc(slug: string): DocSection | undefined {
  return (DOCS_BY_SLUG as Record<string, DocSection | undefined>)[slug]
}

export function generateStaticParams() {
  return DOC_SECTIONS.map((d) => ({ slug: d.slug }))
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await props.params
  const doc = findDoc(slug)
  if (!doc) return { title: 'Not Found' }

  const url = `${APP_URL}/docs/${doc.slug}`
  return {
    title: `${doc.title}: Backenly docs`,
    description: doc.metaDescription,
    openGraph: {
      title: `${doc.title}: Backenly docs`,
      description: doc.metaDescription,
      url,
      type: 'article',
      modifiedTime: DOCS_UPDATED.iso,
    },
    twitter: { card: 'summary_large_image', title: `${doc.title}: Backenly docs`, description: doc.metaDescription },
    alternates: { canonical: url },
  }
}

/** Reading copy: a step up from marketing body, and a step brighter. */
const READ = 'text-[16px] leading-[1.8] tracking-[-0.006em] text-zinc-300 [text-wrap:pretty]'

/** One of the four fixed sections, with a linkable heading. */
function DocBlock({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-[100px]">
      <h2 className={`group text-[24px] text-white md:text-[28px] ${TITLE}`}>
        <a
          href={`#${id}`}
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
        >
          {label}
          <span aria-hidden className="ml-2 text-zinc-600 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            #
          </span>
        </a>
      </h2>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────
   One console section, documented.

   Every page has the same shape, so two sections can be compared at a glance:
   what it is (the paragraph under the title), the walkthrough video, then why
   you would need it, how it works, how to try it, and what to know.

   Three columns at xl: every section on the left, grouped like the console
   sidebar; the page at a reading measure in the middle; "On this page" on the
   right, following the scroll. At lg the right column folds away, and below lg
   the section list moves into a menu at the top of the page.
───────────────────────────────────────────────────────────── */

export default async function DocPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params
  const doc = findDoc(slug)
  if (!doc) notFound()

  const Icon = DOC_ICONS[doc.slug]
  const url = `${APP_URL}/docs/${doc.slug}`

  const order = DOC_SECTIONS.findIndex((d) => d.slug === doc.slug)
  const previous = order > 0 ? DOC_SECTIONS[order - 1] : undefined
  const next = order < DOC_SECTIONS.length - 1 ? DOC_SECTIONS[order + 1] : undefined

  const hasTry = doc.prompts.length > 0 || Boolean(doc.code)
  const toc = DOC_HEADINGS.filter((h) => h.id !== 'try' || hasTry).map((h) => ({ id: h.id, label: h.label }))

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: doc.title,
    description: doc.metaDescription,
    dateModified: DOCS_UPDATED.iso,
    author: { '@type': 'Organization', name: 'Backenly', url: APP_URL },
    publisher: {
      '@type': 'Organization',
      name: 'Backenly',
      url: APP_URL,
      logo: { '@type': 'ImageObject', url: `${APP_URL}/backenly-icon-hd.svg` },
    },
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: APP_URL },
      { '@type': 'ListItem', position: 2, name: 'Documentation', item: `${APP_URL}/docs` },
      { '@type': 'ListItem', position: 3, name: doc.title, item: url },
    ],
  }

  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(articleSchema)} />
      <JsonLd json={safeJsonLd(breadcrumbSchema)} />
      <Page>
        {/* Key light, as on every page, behind the title. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-[260px] left-[-12%] h-[820px] w-[1100px] max-w-none bg-[radial-gradient(closest-side,rgba(255,255,255,0.06),transparent)]"
        />

        <div className={`${CONTAINER} relative pb-[120px] pt-[32px] md:pt-[56px]`}>
          <div className="grid gap-12 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-14 xl:grid-cols-[220px_minmax(0,1fr)_200px] xl:gap-16">
            <aside className="hidden lg:block">
              <DocsSidebar current={doc.slug} />
            </aside>

            <article className="min-w-0 max-w-[760px]">
              <DocsMobileNav current={doc.slug} />

              <header className="hero-enter mt-[28px] lg:mt-0">
                <Trail
                  items={[
                    { label: 'Home', href: '/' },
                    { label: 'Documentation', href: '/docs' },
                    { label: doc.title },
                  ]}
                />
                <div className="mt-7 flex items-center gap-4">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-white/[0.10] bg-white/[0.035]">
                    <Icon aria-hidden strokeWidth={1.75} className="h-[22px] w-[22px] text-violet-300" />
                  </span>
                  <h1
                    className={`bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-1 text-[36px] text-transparent sm:text-[44px] md:text-[50px] ${DISPLAY}`}
                  >
                    {doc.title}
                  </h1>
                  {doc.tag && <DocTag className="text-[12px]">{doc.tag}</DocTag>}
                </div>
                <p className="mt-6 text-[18px] leading-[1.65] tracking-[-0.012em] text-zinc-400 [text-wrap:pretty]">
                  {rich(doc.summary)}
                </p>
                <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-zinc-500">
                  <span>
                    In the console:{' '}
                    <span className="text-zinc-300">{consolePath(doc)}</span>
                  </span>
                  <span aria-hidden className="h-3 w-px bg-white/[0.12]" />
                  <span>Updated {DOCS_UPDATED.display}</span>
                </p>
              </header>

              <div className="mt-10">
                <DocVideo title={doc.title} icon={Icon} video={DOC_VIDEOS[doc.slug]} />
              </div>

              <div className="mt-[56px] flex flex-col gap-16">
                <DocBlock id="why" label="Why you need it">
                  <p className={READ}>{rich(doc.why)}</p>
                  <div className={`p-5 md:p-6 ${PANEL}`}>
                    <p className={`text-[15px] text-white ${HEADING}`}>For example</p>
                    <ul className="mt-3 flex list-disc flex-col gap-2.5 pl-5 marker:text-zinc-600">
                      {doc.examples.map((example) => (
                        <li key={example} className="pl-1.5 text-[15px] leading-[1.7] text-zinc-300 [text-wrap:pretty]">
                          {rich(example)}
                        </li>
                      ))}
                    </ul>
                  </div>
                </DocBlock>

                <DocBlock id="how" label="How it works">
                  <Steps steps={doc.how} />
                </DocBlock>

                {hasTry && (
                  <DocBlock id="try" label="Try it">
                    {doc.prompts.length > 0 && (
                      <>
                        <p className={READ}>
                          {doc.slug === 'connect'
                            ? rich('Once the install command has run, start a new conversation with your agent and ask:')
                            : rich('Once your coding agent is [connected](/docs/connect), ask it:')}
                        </p>
                        {doc.prompts.map((prompt) => (
                          <CodeBlock key={prompt} code={prompt} label="Ask your agent" language="text" wrap />
                        ))}
                      </>
                    )}
                    {doc.code && <CodeBlock code={doc.code.code} label={doc.code.label} language={doc.code.language} />}
                  </DocBlock>
                )}

                <DocBlock id="notes" label="Good to know">
                  <ul className="flex list-disc flex-col gap-3 pl-5 marker:text-zinc-600">
                    {doc.notes.map((note) => (
                      <li key={note} className={`pl-1.5 ${READ}`}>
                        {rich(note)}
                      </li>
                    ))}
                  </ul>
                </DocBlock>
              </div>

              <nav aria-label="Previous and next section" className="mt-20 grid gap-3 sm:grid-cols-2">
                {previous ? (
                  <Link
                    href={`/docs/${previous.slug}`}
                    className={`group flex flex-col gap-2 p-5 transition-colors duration-200 hover:border-white/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${PANEL}`}
                  >
                    <span className="inline-flex items-center gap-1.5 text-[13px] text-zinc-500">
                      <ArrowLeft aria-hidden className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" />
                      Previous
                    </span>
                    <span className={`text-[16px] text-white ${HEADING}`}>{previous.title}</span>
                  </Link>
                ) : (
                  <span className="hidden sm:block" />
                )}
                {next && (
                  <Link
                    href={`/docs/${next.slug}`}
                    className={`group flex flex-col items-end gap-2 p-5 text-right transition-colors duration-200 hover:border-white/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${PANEL}`}
                  >
                    <span className="inline-flex items-center gap-1.5 text-[13px] text-zinc-500">
                      Next
                      <ArrowRight aria-hidden className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                    </span>
                    <span className={`text-[16px] text-white ${HEADING}`}>{next.title}</span>
                  </Link>
                )}
              </nav>
            </article>

            <aside className="hidden xl:block">
              <div className="sticky top-[100px]">
                <p className="mb-3 text-[13px] font-medium text-zinc-500">On this page</p>
                <ScrollSpy label="On this page" items={toc} />
              </div>
            </aside>
          </div>
        </div>
      </Page>
    </SiteShell>
  )
}
