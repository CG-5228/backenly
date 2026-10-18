import type { LucideIcon } from 'lucide-react'
import type { DocVideo as DocVideoSource } from '@/app/docs/videos'

/**
 * The walkthrough slot at the top of every docs page: a 16:9 frame that plays
 * the section's video, or says plainly that it is still to come.
 *
 * The empty state is deliberately not a player. A play button that does nothing
 * is a fake control, and a black box reads as a broken embed, so the frame shows
 * the section's own console icon and one honest line instead.
 *
 * With a video (app/docs/videos.ts): native controls; nothing downloads until
 * the reader presses play (preload="none" over a poster); playsInline, so iOS
 * does not force fullscreen; captions when they exist. No autoplay: this is
 * documentation, watched when the reader chooses to.
 */
export function DocVideo({
  title,
  icon: Icon,
  video,
}: {
  title: string
  icon: LucideIcon
  video?: DocVideoSource
}) {
  if (video) {
    return (
      <figure className="overflow-hidden rounded-2xl border border-white/[0.10] bg-black shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]">
        <video
          className="block aspect-video w-full"
          controls
          preload="none"
          playsInline
          poster={video.poster}
          aria-label={`${title} walkthrough`}
        >
          <source src={video.src} type="video/mp4" />
          {video.captions && <track kind="captions" src={video.captions} srcLang="en" label="English" default />}
        </video>
      </figure>
    )
  }

  return (
    <figure className="relative isolate flex aspect-video flex-col items-center justify-center overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a0b0d] px-6 text-center">
      {/* A dot grid fading toward the edges. On its own layer: a mask on the
          figure itself would fade the text with it. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_65%_65%_at_50%_50%,black,transparent)]"
      />
      {/* The site's violet key light, from above, and the lit top edge. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(139,92,246,0.14),transparent)]"
      />
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.45),transparent)]"
      />

      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.10] bg-white/[0.04] sm:h-14 sm:w-14">
        <Icon aria-hidden strokeWidth={1.75} className="h-5 w-5 text-zinc-200 sm:h-6 sm:w-6" />
      </span>
      <figcaption className="mt-3 sm:mt-4">
        <span className="block text-[15px] font-medium tracking-[-0.01em] text-zinc-200 sm:text-[16px]">
          Walkthrough coming soon
        </span>
        <span className="mt-1.5 block text-[13px] leading-[1.5] text-zinc-500 sm:text-[14px]">
          A 20-second tour of {title} will play here.
        </span>
      </figcaption>
    </figure>
  )
}
