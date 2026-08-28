/**
 * Champ de recherche avec loupe (Input shadcn). Un seul rendu pour Mémoire et
 * Maintenance : même icône, même hauteur, même placeholder « un mot-clé… ».
 */
import type { ComponentProps } from 'react'
import { Search } from 'lucide-react'
import { cn } from '../lib/utils'
import { Input } from './ui/input'

export function MemSearchInput({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <div className={cn('relative min-w-0', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input type="search" autoComplete="off" {...props} className="pl-8" />
    </div>
  )
}
