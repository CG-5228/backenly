'use client'

/**
 * ChangePath: one project over one day and one night, drawn as a timeline
 * that assembles itself the first time it is seen.
 *
 * History: this replaced ChangePlayer (a tab list beside mocked dashboard
 * cards), which read as generated. The founder then asked for a drawing that
 * builds itself, in the visual manner of InsForge's branch timeline: the
 * ANIMATION style, not its scenario. A first cut copied the scenario too
 * (three different agents on one project) and was rejected, rightly: nobody
 * runs Claude Code, Cursor and Codex against one backend. Do not bring
 * brand-name agents back into this drawing.
 *
 * 2026-09-30, made readable. Visitors liked the drawing and could not say
 * what it showed, so it now explains itself: a key for the four colours above
 * it, "you're online" and "nobody online" over day and night, plain labels
 * ("Applied", "Tested 5/5", "NEEDS YOU", "FIX") in the order the product
 * actually works (a change is applied, then tested against the running
 * backend), and three time-keyed explanations under it in place of the five
 * abstract stage names. The landing's separate autonomy section (a looping
 * five-phase instrument, then three facts) was folded in and removed: its
 * receipt now sits in the drawing's empty lower right, where the night story
 * ends, and its facts (every minute, no model calls, snapshot first) are in
 * the third explanation.
 *
 * 2026-10-10, made to look finished, then made to look like this page.
 * Light cards with solid badges on a dark page read as stickers, and the
 * loose parts (a key floating above, a night gradient with a hard right edge,
 * a dotted ruler) read as a sketch. The first pass framed it and darkened the
 * cards, but in its own idiom: thick coloured lines, rounded pills, 13px
 * labels, sans and mono mixed, a panel and a dot grid nothing else on the
 * page uses. It still read as a guest. It is now drawn in the landing's own
 * figure grammar (CapabilityDiagrams: hairline strokes, 5px chips on ink,
 * mono labels, small uppercase tags, colour only where it is a signal), sits
 * in the same window as ConnectTabs, and sets the copy under it with the
 * shared type tokens. The story and its timing are unchanged.
 *
 * THE SCENE is the three things a Backenly user needs to understand, in the
 * order they would meet them:
 *
 *   1. 14:02, your agent adds comments. Planned into typed actions, applied,
 *      tested against the running backend, merged. Governed building.
 *   2. 17:40, your agent asks to drop a column with live rows. Destructive,
 *      so it waits in the Review Queue until you approve; then it applies.
 *      The human gate.
 *   3. 03:12, nobody online. The line passes into night, and the autonomy
 *      loop, with no agent and no person, finds slow queries, snapshots, adds
 *      the missing index, tests it, merges the fix, and writes a receipt.
 *      Self-healing, the thing only Backenly does.
 *
 * Everything named is a real product noun (typed actions, the Review Queue,
 * verification, restore points, the autonomy loop adding indexes; see the
 * Overview recorded in HeroFilm). Times and names are illustrative, and the
 * caption says so.
 *
 * HOW IT DRAWS. One SVG in a fixed 1260x500 coordinate space (padded by
 * PAD_X/PAD_TOP/PAD_BOTTOM inside its window), scaled to the container, shown
 * from xl up, where 12 units land near the 11px the page's other figures use
 * (below that the text would scale under 10px, so smaller screens get the
 * same day drawn upright; see PhoneScene). Lines draw
 * with framer's pathLength; dashed lines draw through a mask, because
 * pathLength works by rewriting stroke-dasharray and would erase the dashes.
 * The sequence starts the first time the figure is 35% on screen. Reduced
 * motion gets the finished drawing with nothing moving.
 */

import { useId, useRef } from 'react'
import { motion, useInView, type Variants } from 'framer-motion'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { BODY, HEADING, RULE } from '@/components/site/tokens'

const W = 1260
const H = 500
const TRACK_Y = 240
/** Room around the drawing inside its panel, in drawing units. */
const PAD_X = 40
const PAD_TOP = 56
const PAD_BOTTOM = 36

const GREEN = '#4ade80'
const AMBER = '#fbbf24'
const VIOLET = '#a78bfa'

/*
 * The landing's figure grammar, from components/landing/CapabilityDiagrams,
 * so this drawing reads as one of the page's figures and not a guest on it:
 * hairline strokes on a three-step ladder, chips on solid ink with a 5px
 * radius, mono labels and small uppercase tags. Lines are never coloured.
 * Colour is kept to the four signals the key names, on dots, rings and tags.
 */

/** The window the desktop drawing sits in: ConnectTabs' surface. */
const PANEL = '#0b0c0f'
/** Solid ink, so a chip or ring occludes whatever line it crosses. */
const INK = '#0b0b0e'
const EDGE = 'rgba(255,255,255,0.09)'
const EDGE_BRIGHT = 'rgba(255,255,255,0.18)'
/** The stroke ladder: the path a change took, the asks, the line itself. */
const KEY = 'rgba(255,255,255,0.38)'
const LEADER = 'rgba(255,255,255,0.26)'

type Tone = 'neutral' | 'green' | 'amber' | 'violet'
const TONES: Record<Tone, { dot: string; tag: string }> = {
  neutral: { dot: '#a1a1aa', tag: '#71717a' },
  green: { dot: GREEN, tag: GREEN },
  amber: { dot: AMBER, tag: AMBER },
  violet: { dot: VIOLET, tag: '#c4b5fd' },
}

/** Radius of a step ring. Connectors stop exactly here; see Outcome. */
const OR = 15

/* ── Motion factories ────────────────────────────────────────────────────── */

type T = (delay: number, duration?: number) => Variants

function makeMotion(quiet: boolean) {
  const d = (delay: number) => (quiet ? 0 : delay)
  const dur = (duration: number) => (quiet ? 0 : duration)

  const draw: T = (delay, duration = 0.5) => ({
    hidden: { pathLength: 0, opacity: 0 },
    visible: {
      pathLength: 1,
      opacity: 1,
      transition: {
        pathLength: { delay: d(delay), duration: dur(duration), ease: [0.65, 0, 0.35, 1] },
        opacity: { delay: d(delay), duration: 0.01 },
      },
    },
  })

  const pop: T = (delay, duration = 0.45) => ({
    hidden: { opacity: 0, scale: 0.4 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: { delay: d(delay), duration: dur(duration), ease: [0.34, 1.56, 0.64, 1] },
    },
  })

  const rise: T = (delay, duration = 0.5) => ({
    hidden: { opacity: 0, y: 8 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { delay: d(delay), duration: dur(duration), ease: [0.16, 1, 0.3, 1] },
    },
  })

  const fade: T = (delay, duration = 0.4) => ({
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { delay: d(delay), duration: dur(duration) } },
  })

  return { draw, pop, rise, fade }
}

type Kit = ReturnType<typeof makeMotion>

/** Scale and pop around the element's own centre, not the SVG origin. */
const CENTRED = { transformBox: 'fill-box', transformOrigin: 'center' } as const

/* ── Primitives ──────────────────────────────────────────────────────────── */

function Line({ d, stroke = KEY, delay, duration, kit }: {
  d: string; stroke?: string; delay: number; duration?: number; kit: Kit
}) {
  return (
    <motion.path d={d} stroke={stroke} strokeWidth={1} fill="none" strokeLinecap="round" variants={kit.draw(delay, duration)} />
  )
}

/** A dashed line that still draws: the dashes are revealed through a mask. */
function Dashed({ d, delay, duration, kit, stroke = LEADER, className, box = [W, H] }: {
  d: string; delay: number; duration?: number; kit: Kit; stroke?: string; className?: string
  /** The canvas the mask must cover: the desktop drawing by default. */
  box?: [number, number]
}) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <>
      <mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={box[0]} height={box[1]}>
        <motion.path d={d} stroke="#fff" strokeWidth={6} fill="none" variants={kit.draw(delay, duration)} />
      </mask>
      <path d={d} stroke={stroke} strokeWidth={1} strokeDasharray="2 4" fill="none" mask={`url(#${id})`} className={className} />
    </>
  )
}

/** An event on the production line: a ring with a lit core. */
function EventNode({ x, color, delay, kit }: { x: number; color: string; delay: number; kit: Kit }) {
  return (
    <motion.g variants={kit.pop(delay)} style={CENTRED}>
      <circle cx={x} cy={TRACK_Y} r={7.5} fill={INK} stroke={color} strokeOpacity={0.6} strokeWidth={1} />
      <circle cx={x} cy={TRACK_Y} r={3} fill={color} />
    </motion.g>
  )
}

function Time({ x, above, children, delay, kit }: {
  x: number; above?: boolean; children: string; delay: number; kit: Kit
}) {
  return (
    <motion.text
      x={x}
      y={above ? TRACK_Y - 20 : TRACK_Y + 30}
      textAnchor="middle"
      className="fill-zinc-500 font-mono"
      fontSize={12}
      variants={kit.fade(delay)}
    >
      {children}
    </motion.text>
  )
}

type Actor = 'agent' | 'autonomy'

/**
 * Line glyphs on a 24 grid: a prompt for your agent, a loop for autonomy. The
 * loop is named "Backenly" on the page: "Autonomy" is the product's word for
 * it, and a visitor does not know that word yet.
 */
const ACTOR: Record<Actor, { tag: string; d: string; color: string; tone: Tone }> = {
  agent: { tag: 'AGENT', d: 'M4.5 7 L9.5 12 L4.5 17 M12 17.5 H19.5', color: '#a1a1aa', tone: 'neutral' },
  autonomy: { tag: 'BACKENLY', d: 'M19.5 12 A7.5 7.5 0 1 1 17.3 6.7 M19.8 3.8 V7.6 H16', color: VIOLET, tone: 'violet' },
}

/**
 * A node chip, the same object CapabilityDiagrams draws: a mono label on ink,
 * an optional lead (a signal dot or an actor glyph) and an uppercase tag at
 * the right. Everything is mono so the width can be computed from the
 * characters: Geist Mono runs 0.6em a character, and the tag adds its 0.14em
 * tracking.
 */
type Lead = 'dot' | Actor

const tagSize = (fs: number) => fs - 2
const chipPad = (fs: number) => (fs >= 12 ? 12 : 10)
const leadWidth = (lead: Lead | undefined, fs: number) => (lead === 'dot' ? 14 : lead ? fs + 10 : 0)

function chipWidth(label: string, tag: string | undefined, lead: Lead | undefined, fs = 12) {
  const ts = tagSize(fs)
  const tagW = tag ? 10 + tag.length * ts * 0.74 - ts * 0.14 : 0
  return chipPad(fs) * 2 + leadWidth(lead, fs) + label.length * fs * 0.6 + tagW
}

function Chip({ x, cy, label, tag, tone = 'neutral', lead, bright, fs = 12, h = 36, delay, kit }: {
  x: number; cy: number; label: string; tag?: string; tone?: Tone; lead?: Lead; bright?: boolean
  fs?: number; h?: number; delay: number; kit: Kit
}) {
  const pad = chipPad(fs)
  const w = chipWidth(label, tag, lead, fs)
  const t = TONES[tone]
  const g = fs + 2
  return (
    <motion.g variants={kit.rise(delay)}>
      <rect x={x} y={cy - h / 2} width={w} height={h} rx={5} fill={INK} stroke={bright ? EDGE_BRIGHT : EDGE} />
      {lead === 'dot' && <circle cx={x + pad + 3} cy={cy} r={3} fill={t.dot} />}
      {lead && lead !== 'dot' && (
        <svg x={x + pad} y={cy - g / 2} width={g} height={g} viewBox="0 0 24 24">
          <path d={ACTOR[lead].d} stroke={ACTOR[lead].color} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <text x={x + pad + leadWidth(lead, fs)} y={cy + fs * 0.35} fontSize={fs} fill={bright ? '#f4f4f5' : '#d4d4d8'} className="font-mono">
        {label}
      </text>
      {tag && (
        <text
          x={x + w - pad}
          y={cy + fs * 0.32}
          textAnchor="end"
          fontSize={tagSize(fs)}
          fontWeight={500}
          letterSpacing="0.14em"
          fill={t.tag}
          className="font-mono"
        >
          {tag}
        </text>
      )}
    </motion.g>
  )
}

/** Who started the change, centred over its branch. */
function ActorPill({ cx, cy, actor, action, delay, kit }: {
  cx: number; cy: number; actor: Actor; action: string; delay: number; kit: Kit
}) {
  const a = ACTOR[actor]
  const w = chipWidth(action, a.tag, actor)
  return <Chip x={cx - w / 2} cy={cy} label={action} tag={a.tag} tone={a.tone} lead={actor} delay={delay} kit={kit} />
}

/** A stage of the change: what it is, and a tag for where it stands. */
function StageCard({ x, cy, badge, label, tone = 'neutral', delay, kit }: {
  x: number; cy: number; badge: string; label: string; tone?: Tone; delay: number; kit: Kit
}) {
  return <Chip x={x} cy={cy} label={label} tag={badge} tone={tone} lead="dot" delay={delay} kit={kit} />
}

const stageWidth = (badge: string, label: string) => chipWidth(label, badge, 'dot')

type Glyph = 'check' | 'up' | 'person'

const GLYPHS: Record<Glyph, string> = {
  check: 'M-5 0.5 L-1.5 4 L5.5 -3.5',
  up: 'M0 5.5 V-5.5 M-4.5 -1 L0 -5.5 L4.5 -1',
  person: 'M0 -1 A3 3 0 1 0 0 -7 A3 3 0 1 0 0 -1 M-5.5 6 A5.5 5 0 0 1 5.5 6',
}

function Outcome({ cx, cy, glyph, color, label, below, delay, kit }: {
  cx: number; cy: number; glyph: Glyph; color: string; label: string; below?: boolean; delay: number; kit: Kit
}) {
  // Connectors stop OR from the centre, and their round caps reach half a
  // unit further, into this ring's 1-unit stroke, so line and ring meet.
  return (
    <>
      <motion.g variants={kit.pop(delay)} style={CENTRED}>
        <circle cx={cx} cy={cy} r={OR} fill={INK} />
        <circle cx={cx} cy={cy} r={OR} fill={color} fillOpacity={0.08} stroke={color} strokeOpacity={0.6} strokeWidth={1} />
        <path d={GLYPHS[glyph]} transform={`translate(${cx} ${cy}) scale(0.8)`} stroke={color} strokeWidth={1.75} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </motion.g>
      <motion.text
        x={cx}
        y={below ? cy + OR + 21 : cy - OR - 12}
        textAnchor="middle"
        fontSize={12}
        className="fill-zinc-400 font-mono"
        variants={kit.fade(delay + 0.1)}
      >
        {label}
      </motion.text>
    </>
  )
}

/* ── The receipt ─────────────────────────────────────────────────────────── */

/**
 * What the night fix leaves behind, drawn where the night story ends. The
 * same four steps the autonomy loop records in the project's journal:
 * detected, snapshot, fixed, tested. Mono columns, widths from the characters
 * (12px Geist Mono is 7.2px a character).
 */
const RECEIPT: { time: string; step: string; detail: string }[] = [
  { time: '03:12', step: 'detected', detail: 'slow queries on orders' },
  { time: '03:12', step: 'snapshot', detail: 'restore point saved first' },
  { time: '03:13', step: 'fixed', detail: 'index on orders.customer_id' },
  { time: '03:14', step: 'tested', detail: 'queries fast again' },
]

function Receipt({ x, y, delay, kit, w = 380 }: { x: number; y: number; delay: number; kit: Kit; w?: number }) {
  const h = 170
  return (
    <motion.g variants={kit.rise(delay)}>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={INK} stroke={EDGE} />
      <path
        d={GLYPHS.check}
        transform={`translate(${x + 22} ${y + 20}) scale(0.75)`}
        stroke={GREEN}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x={x + 36} y={y + 24} fontSize={12} className="fill-zinc-100 font-mono">
        fixed while you slept
      </text>
      <text x={x + w - 16} y={y + 24} textAnchor="end" fontSize={10} fontWeight={500} letterSpacing="0.14em" fill="#c4b5fd" className="font-mono">
        REVERSIBLE
      </text>
      <line x1={x} x2={x + w} y1={y + 40.5} y2={y + 40.5} stroke="rgba(255,255,255,0.07)" />
      {RECEIPT.map((row, i) => (
        <motion.g key={row.step} variants={kit.fade(delay + 0.2 + i * 0.15)}>
          <text x={x + 16} y={y + 64 + i * 22} fontSize={12} className="fill-zinc-500 font-mono">
            {row.time}
          </text>
          <text x={x + 68} y={y + 64 + i * 22} fontSize={12} fill="#c4b5fd" className="font-mono">
            {row.step}
          </text>
          <text x={x + 148} y={y + 64 + i * 22} fontSize={12} className="fill-zinc-200 font-mono">
            {row.detail}
          </text>
        </motion.g>
      ))}
      <line x1={x} x2={x + w} y1={y + 142.5} y2={y + 142.5} stroke="rgba(255,255,255,0.07)" />
      <motion.text x={x + 16} y={y + 160} fontSize={11} className="fill-zinc-500 font-mono" variants={kit.fade(delay + 0.9)}>
        no AI credits spent · checked again at 03:15
      </motion.text>
    </motion.g>
  )
}

/** A sun, for the half of the day when someone is at the keyboard. */
const SUN =
  'M12 8.5 A3.5 3.5 0 1 0 12 15.5 A3.5 3.5 0 1 0 12 8.5 Z M12 2.5 V4.5 M12 19.5 V21.5 M2.5 12 H4.5 M19.5 12 H21.5 M5.3 5.3 L6.7 6.7 M17.3 17.3 L18.7 18.7 M5.3 18.7 L6.7 17.3 M17.3 6.7 L18.7 5.3'

/* ── The scene ───────────────────────────────────────────────────────────── */

function Scene({ kit }: { kit: Kit }) {
  // Branch geometry. Day: A rises, B drops. Night: C rises, and its receipt
  // hangs below the line in the space the day stories leave empty.
  const A = { x: 230, card: 290, cy: 76 }
  const aEnd = A.card + stageWidth('PLAN', '4 safe steps')
  const B = { x: 300, card: 340, cy: 404 }
  const bEnd = B.card + stageWidth('NEEDS YOU', '1,284 rows at risk')
  const C = { x: 870, card: 920, cy: 76 }
  const cEnd = C.card + stageWidth('FIX', 'add missing index')
  const NIGHT = 830
  const RECEIPT_Y = 300
  const PROD = chipWidth('production', 'LIVE', 'dot')

  return (
    <>
      <defs>
        <linearGradient id="cp-track" gradientUnits="userSpaceOnUse" x1={PROD} x2={W + PAD_X} y1={0} y2={0}>
          <stop offset="0" stopColor="#fff" stopOpacity="0.17" />
          <stop offset="0.94" stopColor="#fff" stopOpacity="0.17" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="cp-night" gradientUnits="userSpaceOnUse" x1={NIGHT} x2={W + PAD_X} y1={0} y2={0}>
          <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.025" />
          <stop offset="1" stopColor="#8b5cf6" stopOpacity="0.07" />
        </linearGradient>
      </defs>

      {/* Day: someone is at the keyboard. */}
      <motion.g variants={kit.fade(0.2, 0.6)}>
        <svg x={0} y={-23} width={13} height={13} viewBox="0 0 24 24">
          <path d={SUN} stroke="#71717a" strokeWidth={2} fill="none" strokeLinecap="round" />
        </svg>
        <text x={21} y={-12.5} fontSize={12} className="fill-zinc-500 font-mono">
          day · you&apos;re online
        </text>
      </motion.g>

      {/* Night falls once the day's work has merged: a band that runs to the
          panel's edges, marked off from the day by a dashed divider. */}
      <motion.g variants={kit.fade(2.5, 0.9)}>
        <rect x={NIGHT} y={-PAD_TOP} width={W - NIGHT + PAD_X} height={H + PAD_TOP + PAD_BOTTOM} fill="url(#cp-night)" />
        <line x1={NIGHT + 0.5} x2={NIGHT + 0.5} y1={-PAD_TOP} y2={H + PAD_BOTTOM} stroke="rgba(255,255,255,0.10)" strokeDasharray="2 4" />
        <svg x={NIGHT + 20} y={-23} width={13} height={13} viewBox="0 0 24 24">
          <path d="M20 14.5 A8.5 8.5 0 1 1 9.5 4 A7 7 0 0 0 20 14.5 Z" fill={VIOLET} fillOpacity={0.8} />
        </svg>
        <text x={NIGHT + 41} y={-12.5} fontSize={12} className="font-mono" fill="#8b86a8">
          night · nobody online
        </text>
      </motion.g>

      {/* Production, and the line it runs along. */}
      <Chip x={0} cy={TRACK_Y} label="production" tag="LIVE" tone="green" lead="dot" bright delay={0} kit={kit} />
      <motion.path d={`M${PROD} ${TRACK_Y} H${W + PAD_X}`} stroke="url(#cp-track)" strokeWidth={1} fill="none" variants={kit.draw(0.15, 1.6)} />

      {/* 1 · Afternoon. Your agent adds comments: planned, applied, tested. */}
      <EventNode x={A.x} color="#e4e4e7" delay={0.35} kit={kit} />
      <Time x={A.x} delay={0.4} kit={kit}>14:02</Time>
      <Dashed d={`M${A.x} ${TRACK_Y - 8} V188`} delay={0.5} duration={0.3} kit={kit} />
      <ActorPill cx={A.x} cy={170} actor="agent" action="add comments" delay={0.7} kit={kit} />
      <Dashed d={`M${A.x} 152 V100 A24 24 0 0 1 ${A.x + 24} ${A.cy} H${A.card}`} delay={0.9} duration={0.45} kit={kit} />
      <StageCard x={A.card} cy={A.cy} badge="PLAN" label="4 safe steps" delay={1.25} kit={kit} />
      <Line d={`M${aEnd} ${A.cy} H${540 - OR}`} delay={1.5} duration={0.25} kit={kit} />
      <Outcome cx={540} cy={A.cy} glyph="up" color={GREEN} label="applied" delay={1.7} kit={kit} />
      <Line d={`M${540 + OR} ${A.cy} H${630 - OR}`} delay={1.85} duration={0.25} kit={kit} />
      <Outcome cx={630} cy={A.cy} glyph="check" color={GREEN} label="tested 5/5" delay={2.05} kit={kit} />
      <Line d={`M${630 + OR} ${A.cy} H690 A30 30 0 0 1 720 106 V${TRACK_Y - 8}`} delay={2.2} duration={0.5} kit={kit} />
      <EventNode x={720} color={GREEN} delay={2.65} kit={kit} />

      {/* 2 · Evening. A destructive ask waits for you; you approve; it applies. */}
      <EventNode x={B.x} color="#e4e4e7" delay={0.65} kit={kit} />
      <Time x={B.x} above delay={0.7} kit={kit}>17:40</Time>
      <Dashed d={`M${B.x} ${TRACK_Y + 8} V292`} delay={1.0} duration={0.3} kit={kit} />
      <ActorPill cx={B.x} cy={310} actor="agent" action="drop legacy_slug" delay={1.2} kit={kit} />
      <Dashed d={`M${B.x} 328 V380 A24 24 0 0 0 ${B.x + 24} ${B.cy} H${B.card}`} delay={1.4} duration={0.45} kit={kit} />
      <StageCard x={B.card} cy={B.cy} badge="NEEDS YOU" label="1,284 rows at risk" tone="amber" delay={1.75} kit={kit} />
      <Line d={`M${bEnd} ${B.cy} H${630 - OR}`} delay={2.0} duration={0.25} kit={kit} />
      <Outcome cx={630} cy={B.cy} glyph="person" color={AMBER} label="you approved" below delay={2.25} kit={kit} />
      <Line d={`M${630 + OR} ${B.cy} H${720 - OR}`} delay={2.4} duration={0.25} kit={kit} />
      <Outcome cx={720} cy={B.cy} glyph="up" color={GREEN} label="applied" below delay={2.6} kit={kit} />
      <Line d={`M${720 + OR} ${B.cy} H760 A30 30 0 0 0 790 374 V${TRACK_Y + 8}`} delay={2.75} duration={0.5} kit={kit} />
      <EventNode x={790} color={GREEN} delay={3.2} kit={kit} />

      {/* 3 · 03:12, nobody online. Backenly finds it, fixes it, tests it,
          and leaves a receipt, with no agent and no person involved. */}
      <EventNode x={C.x} color={VIOLET} delay={3.1} kit={kit} />
      <Time x={C.x} delay={3.15} kit={kit}>03:12</Time>
      <Dashed d={`M${C.x} ${TRACK_Y - 8} V188`} delay={3.25} duration={0.3} kit={kit} />
      <ActorPill cx={C.x} cy={170} actor="autonomy" action="finds slow queries" delay={3.45} kit={kit} />
      <Dashed
        d={`M${C.x} 152 V100 A24 24 0 0 1 ${C.x + 24} ${C.cy} H${C.card}`}
        delay={3.65}
        duration={0.4}
        kit={kit}
      />
      <StageCard x={C.card} cy={C.cy} badge="FIX" label="add missing index" tone="violet" delay={4.0} kit={kit} />
      <Line d={`M${cEnd} ${C.cy} H${1150 - OR}`} delay={4.25} duration={0.2} kit={kit} />
      <Outcome cx={1150} cy={C.cy} glyph="check" color={GREEN} label="tested" delay={4.4} kit={kit} />
      <Line d={`M${1150 + OR} ${C.cy} H1190 A30 30 0 0 1 1220 106 V${TRACK_Y - 8}`} delay={4.55} duration={0.5} kit={kit} />
      <EventNode x={1220} color={GREEN} delay={5.0} kit={kit} />
      <motion.text x={1206} y={TRACK_Y + 30} textAnchor="end" fontSize={12} className="fill-zinc-500 font-mono" variants={kit.fade(5.05)}>
        03:14
      </motion.text>
      <Dashed d={`M1220 ${TRACK_Y + 8} V${RECEIPT_Y}`} delay={5.1} duration={0.25} kit={kit} />
      <Receipt x={872} y={RECEIPT_Y} delay={5.3} kit={kit} />
    </>
  )
}

/* ── The phone drawing ───────────────────────────────────────────────────── */

/*
 * Below xl the same day is drawn upright: production runs down the middle,
 * each change branches off to one side, passes its steps, and merges back, the
 * way a branch timeline reads on a phone. Same colours, same stories, same
 * receipt; only the geometry turns.
 *
 * It is taller than a phone screen, so it does not play in one go. Each story
 * is a chapter that starts when it scrolls into view, which is also how the
 * reader meets it. Reduced motion gets every chapter finished and still.
 *
 * Coordinates are a 390-unit-wide canvas, drawn at 1:1 on a 390px phone and
 * capped at 440px so a tablet does not blow the type up.
 */

const MW = 390
const MH = 1056
const TX = 195 // the production line
const RC = 300 // right-hand branches
const LC = 82 // left-hand branches
/** Phone type: one size down from the desktop's, as CapabilityDiagrams sets it. */
const MFS = 11
/** Phone step rings: connectors stop 16 from the centre, inside this stroke. */
const MOR = 15.5

/** Keep a pill or card on its own side of the line, inside the canvas. */
function fit(center: number, w: number, side: 'left' | 'right') {
  const [lo, hi] = side === 'right' ? [TX + 14, MW - 8] : [8, TX - 14]
  return Math.min(Math.max(center - w / 2, lo), hi - w)
}

function MNode({ y, color, delay, kit }: { y: number; color: string; delay: number; kit: Kit }) {
  return (
    <motion.g variants={kit.pop(delay)} style={CENTRED}>
      <circle cx={TX} cy={y} r={7.5} fill={INK} stroke={color} strokeOpacity={0.6} strokeWidth={1} />
      <circle cx={TX} cy={y} r={3} fill={color} />
    </motion.g>
  )
}

/** A time sits on the side of the line its branch does not use. */
function MTime({ y, side, delay, kit, children }: { y: number; side: 'left' | 'right'; delay: number; kit: Kit; children: string }) {
  return (
    <motion.text
      x={side === 'left' ? TX - 16 : TX + 16}
      y={y + 4}
      textAnchor={side === 'left' ? 'end' : 'start'}
      fontSize={11}
      className="fill-zinc-500 font-mono"
      variants={kit.fade(delay)}
    >
      {children}
    </motion.text>
  )
}

/** Who started the change. No tag on the phone: there is no room for one. */
function MPill({ col, cy, side, actor, action, delay, kit }: {
  col: number; cy: number; side: 'left' | 'right'; actor: Actor; action: string; delay: number; kit: Kit
}) {
  const x = fit(col, chipWidth(action, undefined, actor, MFS), side)
  return <Chip x={x} cy={cy} label={action} lead={actor} fs={MFS} h={32} delay={delay} kit={kit} />
}

function MCard({ col, cy, side, badge, label, tone = 'neutral', delay, kit }: {
  col: number; cy: number; side: 'left' | 'right'; badge: string; label: string; tone?: Tone; delay: number; kit: Kit
}) {
  const x = fit(col, chipWidth(label, badge, 'dot', MFS), side)
  return <Chip x={x} cy={cy} label={label} tag={badge} tone={tone} lead="dot" fs={MFS} delay={delay} kit={kit} />
}

/** A step on a branch, labelled on the side that faces the production line. */
function MOutcome({ cx, cy, glyph, color, label, delay, kit }: {
  cx: number; cy: number; glyph: Glyph; color: string; label: string; delay: number; kit: Kit
}) {
  const labelLeft = cx > TX
  return (
    <>
      <motion.g variants={kit.pop(delay)} style={CENTRED}>
        <circle cx={cx} cy={cy} r={MOR} fill={INK} />
        <circle cx={cx} cy={cy} r={MOR} fill={color} fillOpacity={0.08} stroke={color} strokeOpacity={0.6} strokeWidth={1} />
        <path d={GLYPHS[glyph]} transform={`translate(${cx} ${cy}) scale(0.8)`} stroke={color} strokeWidth={1.75} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </motion.g>
      <motion.text
        x={labelLeft ? cx - 26 : cx + 26}
        y={cy + 4}
        textAnchor={labelLeft ? 'end' : 'start'}
        fontSize={MFS}
        className="fill-zinc-400 font-mono"
        variants={kit.fade(delay + 0.1)}
      >
        {label}
      </motion.text>
    </>
  )
}

/** One story: it plays when it scrolls into view, or is simply there. */
function Chapter({ quiet, children }: { quiet: boolean; children: React.ReactNode }) {
  return quiet ? (
    <motion.g initial="hidden" animate="visible">
      {children}
    </motion.g>
  ) : (
    <motion.g initial="hidden" whileInView="visible" viewport={{ once: true, amount: 0.3 }}>
      {children}
    </motion.g>
  )
}

function PhoneScene({ kit, quiet }: { kit: Kit; quiet: boolean }) {
  const box: [number, number] = [MW, MH]
  const prod = chipWidth('production', 'LIVE', 'dot', MFS)

  return (
    <>
      <defs>
        {/* An ellipse inside the night's box, spent before any edge, so the
            night has no hard border where the canvas stops short of the page. */}
        <radialGradient id="cpm-night" cx="0.5" cy="0.56" r="0.5">
          <stop offset="0" stopColor="#4c1d95" stopOpacity="0.36" />
          <stop offset="0.55" stopColor="#4c1d95" stopOpacity="0.14" />
          <stop offset="1" stopColor="#4c1d95" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="cpm-track" gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={70} y2={842}>
          <stop offset="0" stopColor="#fff" stopOpacity="0.17" />
          <stop offset="0.94" stopColor="#fff" stopOpacity="0.17" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.08" />
        </linearGradient>
      </defs>

      {/* Day, production, and the line it runs along. */}
      <Chapter quiet={quiet}>
        <motion.g variants={kit.fade(0.1, 0.5)}>
          <svg x={14} y={6} width={13} height={13} viewBox="0 0 24 24">
            <path d={SUN} stroke="#71717a" strokeWidth={2} fill="none" strokeLinecap="round" />
          </svg>
          <text x={34} y={17} fontSize={11} className="fill-zinc-500 font-mono">
            day · you&apos;re online
          </text>
        </motion.g>
        <Chip x={TX - prod / 2} cy={51} label="production" tag="LIVE" tone="green" lead="dot" bright fs={MFS} h={38} delay={0} kit={kit} />
        <motion.path d={`M${TX} 70 V842`} stroke="url(#cpm-track)" strokeWidth={1} fill="none" variants={kit.draw(0.15, 1.8)} />
      </Chapter>

      {/* 14:02 · Your agent adds comments: planned, applied, tested. Right. */}
      <Chapter quiet={quiet}>
        <MNode y={118} color="#e4e4e7" delay={0} kit={kit} />
        <MTime y={118} side="left" delay={0.05} kit={kit}>14:02</MTime>
        <Dashed d={`M${TX + 8} 118 H${RC - 20} A20 20 0 0 1 ${RC} 138 V152`} delay={0.15} duration={0.35} kit={kit} box={box} />
        <MPill col={RC} cy={168} side="right" actor="agent" action="add comments" delay={0.4} kit={kit} />
        <Dashed d={`M${RC} 184 V208`} delay={0.6} duration={0.2} kit={kit} box={box} />
        <MCard col={RC} cy={226} side="right" badge="PLAN" label="4 safe steps" delay={0.75} kit={kit} />
        <Line d={`M${RC} 244 V274`} delay={0.95} duration={0.2} kit={kit} />
        <MOutcome cx={RC} cy={290} glyph="up" color={GREEN} label="applied" delay={1.1} kit={kit} />
        <Line d={`M${RC} 306 V334`} delay={1.25} duration={0.2} kit={kit} />
        <MOutcome cx={RC} cy={350} glyph="check" color={GREEN} label="tested 5/5" delay={1.4} kit={kit} />
        <Line d={`M${RC} 366 V390 A22 22 0 0 1 ${RC - 22} 412 H${TX + 8}`} delay={1.55} duration={0.45} kit={kit} />
        <MNode y={412} color={GREEN} delay={1.95} kit={kit} />
      </Chapter>

      {/* 17:40 · Your agent asks to drop a column: it waits for you. Left. */}
      <Chapter quiet={quiet}>
        <MNode y={196} color="#e4e4e7" delay={0} kit={kit} />
        <MTime y={196} side="right" delay={0.05} kit={kit}>17:40</MTime>
        <Dashed d={`M${TX - 8} 196 H${LC + 20} A20 20 0 0 0 ${LC} 216 V234`} delay={0.15} duration={0.35} kit={kit} box={box} />
        <MPill col={LC} cy={250} side="left" actor="agent" action="drop legacy_slug" delay={0.4} kit={kit} />
        <Dashed d={`M${LC} 266 V290`} delay={0.6} duration={0.2} kit={kit} box={box} />
        <MCard col={LC} cy={308} side="left" badge="NEEDS YOU" label="1,284 rows" tone="amber" delay={0.75} kit={kit} />
        <Line d={`M${LC} 326 V356`} delay={0.95} duration={0.2} kit={kit} />
        <MOutcome cx={LC} cy={372} glyph="person" color={AMBER} label="you approved" delay={1.1} kit={kit} />
        <Line d={`M${LC} 388 V418`} delay={1.25} duration={0.2} kit={kit} />
        <MOutcome cx={LC} cy={434} glyph="up" color={GREEN} label="applied" delay={1.4} kit={kit} />
        <Line d={`M${LC} 450 V470 A22 22 0 0 0 ${LC + 22} 492 H${TX - 8}`} delay={1.55} duration={0.45} kit={kit} />
        <MNode y={492} color={GREEN} delay={1.95} kit={kit} />
      </Chapter>

      {/* 03:12 · Nobody online: Backenly fixes it and leaves a receipt. */}
      <Chapter quiet={quiet}>
        <motion.g variants={kit.fade(0, 0.8)}>
          <rect x={0} y={500} width={MW} height={MH - 500} fill="url(#cpm-night)" />
          <svg x={14} y={538} width={13} height={13} viewBox="0 0 24 24">
            <path d="M20 14.5 A8.5 8.5 0 1 1 9.5 4 A7 7 0 0 0 20 14.5 Z" fill={VIOLET} fillOpacity={0.8} />
          </svg>
          <text x={34} y={549} fontSize={11} className="font-mono" fill="#8b86a8">
            night · nobody online
          </text>
        </motion.g>
        <MNode y={600} color={VIOLET} delay={0.2} kit={kit} />
        <MTime y={600} side="left" delay={0.25} kit={kit}>03:12</MTime>
        <Dashed d={`M${TX + 8} 600 H${RC - 20} A20 20 0 0 1 ${RC} 620 V638`} delay={0.35} duration={0.35} kit={kit} box={box} />
        <MPill col={RC} cy={654} side="right" actor="autonomy" action="finds slow queries" delay={0.6} kit={kit} />
        <Dashed d={`M${RC} 670 V694`} delay={0.8} duration={0.2} kit={kit} box={box} />
        <MCard col={RC} cy={712} side="right" badge="FIX" label="add missing index" tone="violet" delay={0.95} kit={kit} />
        <Line d={`M${RC} 730 V760`} delay={1.15} duration={0.2} kit={kit} />
        <MOutcome cx={RC} cy={776} glyph="check" color={GREEN} label="tested" delay={1.3} kit={kit} />
        <Line d={`M${RC} 792 V812 A22 22 0 0 1 ${RC - 22} 834 H${TX + 8}`} delay={1.45} duration={0.45} kit={kit} />
        <MNode y={834} color={GREEN} delay={1.85} kit={kit} />
        <MTime y={834} side="left" delay={1.9} kit={kit}>03:14</MTime>
        <Dashed d={`M${TX} 842 V868`} delay={2.0} duration={0.2} kit={kit} box={box} />
        <Receipt x={12} y={868} w={MW - 24} delay={2.2} kit={kit} />
      </Chapter>
    </>
  )
}

/* ── The key and the explanations ───────────────────────────────────────── */

const LEGEND: { label: string; color: string }[] = [
  { label: 'Your agent asks', color: '#e4e4e7' },
  { label: 'Waits for you', color: AMBER },
  { label: 'Backenly, on its own', color: VIOLET },
  { label: 'Applied and tested', color: GREEN },
]

/**
 * The three moments of the drawing, keyed by the times printed on its line so
 * a reader can match each paragraph to its branch. The third carries what the
 * landing's separate autonomy section used to say.
 */
const STORIES: { time: string; title: string; body: string; color: string }[] = [
  {
    time: '14:02',
    title: 'Your agent ships a feature',
    body: 'Backenly turns the request into planned steps, applies them behind a restore point, then tests the live backend with real requests. Done means it works, not that it ran.',
    color: GREEN,
  },
  {
    time: '17:40',
    title: 'Anything risky waits for you',
    body: 'A change that would delete data stops and shows you exactly what it touches. Your agent can ask. Only you can approve, and every change can be undone.',
    color: AMBER,
  },
  {
    time: '03:12',
    title: 'Backenly fixes it while you sleep',
    body: 'Every minute, on every plan, Backenly checks the live backend. It snapshots first, fixes only what is safe, tests the fix, and never spends your AI credits doing it.',
    color: VIOLET,
  },
]

const DESCRIPTION =
  'One day and night on production. At 14:02 your agent adds comments: Backenly plans 4 safe steps, applies them, and tests them 5 of 5. At 17:40 your agent asks to drop a column with 1,284 live rows: it waits until you approve, then applies. At 03:12, with nobody online, Backenly finds slow queries, saves a restore point, adds the missing index, tests it, and leaves you a receipt.'

/** The key's marks: the same ring-and-core the drawing puts on its line. */
function KeyItems() {
  return (
    <>
      {LEGEND.map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <span
            aria-hidden
            className="flex h-3 w-3 items-center justify-center rounded-full border"
            style={{ borderColor: item.color }}
          >
            <span className="h-[5px] w-[5px] rounded-full" style={{ background: item.color }} />
          </span>
          {item.label}
        </li>
      ))}
    </>
  )
}

const CAPTION = 'One project, one day and one night, drawn from the real flow. Names and times are illustrative.'

export function ChangePath() {
  const quiet = useSettledReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.35 })
  const kit = makeMotion(quiet)

  return (
    <figure>
      {/* The key: what each colour on the drawing means. On desktop it sits
          in the window's header instead. */}
      <ul
        aria-label="How to read the timeline"
        className="mx-auto mb-10 grid max-w-[440px] grid-cols-2 gap-x-4 gap-y-3 text-[13px] tracking-[-0.006em] text-zinc-400 xl:hidden"
      >
        <KeyItems />
      </ul>

      {/* Desktop: the drawing sits in the same window as ConnectTabs (surface,
          edge, header strip, footer note), so the page's two framed figures
          are one object. */}
      <div
        ref={ref}
        className="hidden overflow-hidden rounded-2xl border border-white/[0.09] shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_40px_120px_-40px_rgba(0,0,0,0.9)] xl:block"
        style={{ background: PANEL }}
      >
        <div className="flex items-center justify-between gap-6 border-b border-white/[0.07] bg-white/[0.015] px-5 py-3.5">
          <p className="flex items-center gap-2.5 text-[13px] font-medium tracking-[-0.006em] text-white">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Production
            <span className="font-normal text-zinc-500">One day and one night</span>
          </p>
          <ul aria-label="How to read the timeline" className="flex items-center gap-x-6 text-[13px] tracking-[-0.006em] text-zinc-400">
            <KeyItems />
          </ul>
        </div>
        <motion.svg
          viewBox={`${-PAD_X} ${-PAD_TOP} ${W + PAD_X * 2} ${H + PAD_TOP + PAD_BOTTOM}`}
          className="block h-auto w-full select-none"
          role="img"
          aria-label={DESCRIPTION}
          initial="hidden"
          animate={inView || quiet ? 'visible' : 'hidden'}
        >
          <Scene kit={kit} />
        </motion.svg>
        <p className="border-t border-white/[0.05] px-5 py-3.5 text-[13px] leading-[1.6] text-zinc-500">{CAPTION}</p>
      </div>

      {/* Phones and tablets: the same day, upright. */}
      <div className="xl:hidden">
        <svg
          viewBox={`0 0 ${MW} ${MH}`}
          className="mx-auto block h-auto w-full max-w-[440px] select-none overflow-visible"
          role="img"
          aria-label={DESCRIPTION}
        >
          <PhoneScene kit={kit} quiet={quiet} />
        </svg>
        <p className="mx-auto mt-3 max-w-[440px] text-center text-[13px] leading-[1.6] text-zinc-500">{CAPTION}</p>
      </div>

      {/* What just happened, keyed by the times on the drawing. Set like the
          page's other three-up rows: a rule, then a heading and body copy
          from the shared tokens. */}
      <figcaption className="mt-12 grid gap-x-8 gap-y-9 md:grid-cols-3 xl:mt-14">
        {STORIES.map((story) => (
          <div key={story.time} className={`border-t ${RULE} pt-5`}>
            <p className="font-mono text-[12px]" style={{ color: story.color }}>
              {story.time}
            </p>
            <h3 className={`mt-3 text-[17px] text-white ${HEADING}`}>{story.title}</h3>
            <p className={`mt-2 max-w-[48ch] ${BODY} text-zinc-400`}>{story.body}</p>
          </div>
        ))}
      </figcaption>
    </figure>
  )
}
