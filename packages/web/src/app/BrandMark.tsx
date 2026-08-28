import { cn } from '../lib/utils'

/**
 * Symbole de marque : « M » formé de nœuds reliés (cf. brand/ + public/favicon.svg).
 * Hérite de la couleur via currentColor — on lui donne `text-primary`.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={cn('size-8 shrink-0', className)} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M30 32 V68 M30 32 L50 55 L70 32 M70 32 V68" />
      </g>
      <g fill="currentColor">
        <circle cx={30} cy={32} r={7} />
        <circle cx={30} cy={68} r={6} />
        <circle cx={50} cy={55} r={7} />
        <circle cx={70} cy={32} r={7} />
        <circle cx={70} cy={68} r={6} />
      </g>
    </svg>
  )
}
